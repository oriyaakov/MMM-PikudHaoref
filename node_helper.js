const NodeHelper = require("node_helper");
const https = require("https");
const RotatingLogger = require("./logger");

module.exports = NodeHelper.create({
	start: function () {
		this.alertInterval = null;
		this.logger = new RotatingLogger({
			maxSize: 512 * 1024,  // 512KB per log file
			maxFiles: 3           // 3 rotated files = ~2MB max total
		});
		this.logger.info("========================================");
		this.logger.info("=== MMM-PikudHaoref node_helper started ===");
		this.logger.info("Log rotation config: 512KB per file, 3 rotated files, ~2MB max total");

		// Tracking counters for diagnostics
		this.lastAlertState = "none";
		this.fetchCount = 0;
		this.errorCount = 0;
		this.consecutiveErrors = 0;
		this.lastResponseType = null; // Track what the API returned last time
	},

	socketNotificationReceived: function (notification, payload) {
		this.logger.info("Received socket notification from frontend: " + notification);

		if (notification === "START_POLLING") {
			this.config = payload;
			this.logger.info("Frontend sent config for polling", {
				pollingInterval: this.config.pollingInterval,
				shelterTime: this.config.shelterTime,
				alertDuration: this.config.alertDuration,
				monitoredCities: this.config.cities,
				monitoredCitiesCount: (this.config.cities || []).length,
				mapZoomNormal: this.config.mapZoomNormal,
				mapZoomAlert: this.config.mapZoomAlert
			});
			this.startPolling();
		}
	},

	startPolling: function () {
		if (this.alertInterval) {
			this.logger.info("Clearing previous polling interval before starting new one");
			clearInterval(this.alertInterval);
		}

		var interval = this.config.pollingInterval || 3000;
		this.logger.info("Starting alert polling - interval: " + interval + "ms (" + (interval / 1000) + "s)");
		this.logger.info("API endpoint: https://www.oref.org.il/WarningMessages/alert/alerts.json");

		this.fetchAlerts();
		this.alertInterval = setInterval(() => {
			this.fetchAlerts();
		}, interval);
	},

	fetchAlerts: function () {
		this.fetchCount++;
		var url = "https://www.oref.org.il/WarningMessages/alert/alerts.json";

		// Log periodic fetch status (every 5 minutes)
		this.logger.infoT("fetch-status",
			"Polling status - total requests: " + this.fetchCount +
			", total errors: " + this.errorCount +
			", consecutive errors: " + this.consecutiveErrors +
			", last state: " + this.lastAlertState,
			null, 300000);

		var options = {
			headers: {
				"Referer": "https://www.oref.org.il/",
				"X-Requested-With": "XMLHttpRequest",
				"Accept": "application/json",
				"Accept-Language": "he"
			},
			timeout: 5000
		};

		var self = this;

		var req = https.get(url, options, function (res) {
			var data = "";

			// Log non-200 responses immediately (these are important for debugging)
			if (res.statusCode !== 200) {
				self.logger.warn("Non-200 HTTP response from oref API", {
					statusCode: res.statusCode,
					statusMessage: res.statusMessage,
					contentType: res.headers["content-type"],
					contentLength: res.headers["content-length"]
				});
			} else {
				// Log 200 OK periodically (every 5 min)
				self.logger.debugT("http-200", "HTTP 200 OK from oref API", {
					contentType: res.headers["content-type"],
					contentLength: res.headers["content-length"]
				}, 300000);
			}

			res.on("data", function (chunk) {
				data += chunk;
			});

			res.on("end", function () {
				self.consecutiveErrors = 0;

				// Inspect raw response for debugging
				var rawLen = data.length;
				var rawPreview = data.length > 200 ? data.substring(0, 200) + "..." : data;
				var firstCharCodes = data.substring(0, 20).split("").map(function (c) { return c.charCodeAt(0); });

				// === STEP 1: Check for empty or whitespace-only response ===
				if (!data || data.trim() === "") {
					var responseType = rawLen === 0 ? "EMPTY" : "WHITESPACE_ONLY";

					// Log on type change, or periodically
					if (self.lastResponseType !== responseType) {
						self.logger.info("Response type changed: " + (self.lastResponseType || "FIRST_CHECK") + " -> " + responseType, {
							rawLength: rawLen,
							charCodes: firstCharCodes
						});
						self.lastResponseType = responseType;
					} else {
						self.logger.debugT("empty-response",
							"Response is " + responseType + " (" + rawLen + " chars) - no active alerts",
							null, 300000);
					}

					self.sendSocketNotification("ALERT_DATA", {
						type: "none",
						cities: []
					});
					return;
				}

				// === STEP 2: Remove BOM (byte order mark) if present ===
				if (data.charCodeAt(0) === 0xFEFF) {
					self.logger.debug("BOM (U+FEFF) detected at position 0, removing it");
					data = data.slice(1);

					if (!data || data.trim() === "") {
						self.logger.debugT("bom-whitespace",
							"After BOM removal, response is empty/whitespace - no active alerts",
							null, 300000);
						self.lastResponseType = "BOM_WHITESPACE";
						self.sendSocketNotification("ALERT_DATA", {
							type: "none",
							cities: []
						});
						return;
					}
				}

				// === STEP 3: Parse JSON ===
				try {
					self.logger.debug("Attempting JSON parse - " + rawLen + " chars, preview: " + JSON.stringify(rawPreview));
					var alert = JSON.parse(data);

					// === STEP 4: Validate alert structure ===
					if (!alert) {
						self.logger.warn("JSON parsed to falsy value", { parsedValue: String(alert) });
						self.lastResponseType = "FALSY_JSON";
						self.sendSocketNotification("ALERT_DATA", { type: "none", cities: [] });
						return;
					}

					if (!alert.data || alert.data.length === 0) {
						if (self.lastResponseType !== "EMPTY_DATA") {
							self.logger.info("Response type changed: " + (self.lastResponseType || "FIRST_CHECK") + " -> EMPTY_DATA (valid JSON but no alert.data)", {
								keys: Object.keys(alert),
								hasData: !!alert.data,
								dataLength: alert.data ? alert.data.length : 0
							});
							self.lastResponseType = "EMPTY_DATA";
						} else {
							self.logger.debugT("empty-data",
								"Valid JSON but alert.data is empty - no active alerts",
								null, 300000);
						}
						self.sendSocketNotification("ALERT_DATA", { type: "none", cities: [] });
						return;
					}

					// ========================================
					// *** ACTIVE ALERT DETECTED ***
					// ========================================
					var alertType = self.getAlertType(alert.cat);

					// === STEP 4b: Filter out informational/non-actionable categories ===
					// Category 10 = "בדקות הקרובות צפויות להתקבל התרעות באזורך"
					// (pre-warning: "alerts expected in coming minutes") — NOT a shelter alert
					if (alertType === "info" || alertType === "unknown") {
						self.logger.infoT("info-alert",
							"Ignoring non-actionable alert (not a shelter alert)", {
								categoryId: alert.cat,
								alertType: alertType,
								title: alert.title,
								totalCities: (alert.data || []).length
							});

						if (self.lastResponseType !== "INFO_ALERT") {
							self.logger.info("Response type changed: " + (self.lastResponseType || "FIRST_CHECK") + " -> INFO_ALERT (cat " + alert.cat + " ignored)");
							self.lastResponseType = "INFO_ALERT";
						}
						self.sendSocketNotification("ALERT_DATA", { type: "none", cities: [] });
						return;
					}

					self.lastResponseType = "ACTIVE_ALERT";

					var alertCities = alert.data || [];
					var monitoredCities = self.config.cities || [];

					self.logger.info("!!! ACTIVE ALERT FROM OREF API !!!", {
						type: alertType,
						categoryId: alert.cat,
						title: alert.title,
						totalAlertCities: alertCities.length,
						allCities: alertCities
					});

					// === STEP 5: Match alert cities against monitored list ===
					var matchedCities;
					if (monitoredCities.length === 0) {
						matchedCities = alertCities;
						self.logger.info("No city filter configured - monitoring ALL cities, passing through all " + alertCities.length + " cities");
					} else {
						self.logger.info("Matching alert cities against monitored list", {
							monitoredCities: monitoredCities,
							alertCities: alertCities
						});

						matchedCities = alertCities.filter(function (city) {
							return monitoredCities.some(function (monitored) {
								var cityIncludesMonitored = city.includes(monitored);
								var monitoredIncludesCity = monitored.includes(city);
								var isMatch = cityIncludesMonitored || monitoredIncludesCity;
								if (isMatch) {
									self.logger.debug("CITY MATCH: alert city '" + city + "' <-> monitored '" + monitored + "' (cityInclMon=" + cityIncludesMonitored + ", monInclCity=" + monitoredIncludesCity + ")");
								}
								return isMatch;
							});
						});

						self.logger.info("City matching complete: " + matchedCities.length + " of " + alertCities.length + " cities matched", {
							matched: matchedCities,
							unmatched: alertCities.filter(function (c) { return !matchedCities.includes(c); })
						});
					}

					// === STEP 6: Determine final result type and log state changes ===
					var resultType = matchedCities.length > 0 ? alertType : "none";

					if (resultType !== self.lastAlertState) {
						self.logger.info("*** STATE TRANSITION: '" + self.lastAlertState + "' -> '" + resultType + "' ***", {
							reason: matchedCities.length > 0
								? "Matched " + matchedCities.length + " cities with alert type '" + alertType + "'"
								: "Alert active but 0 monitored cities matched - treating as 'none'",
							matchedCities: matchedCities,
							alertType: alertType
						});
						self.lastAlertState = resultType;
					}

					// === STEP 7: Send notification to frontend ===
					var payload = {
						type: resultType,
						cities: matchedCities,
						allCities: alertCities,
						title: alert.title || "",
						category: alert.cat || 0,
						timestamp: Date.now()
					};

					self.logger.info("Sending ALERT_DATA to frontend", payload);
					self.sendSocketNotification("ALERT_DATA", payload);

				} catch (e) {
					self.errorCount++;

					// Log parse error with full diagnostic context (throttled to 1/min)
					self.logger.errorT("parse-error",
						"JSON parse FAILED: " + e.message, {
							responseLength: rawLen,
							first100Chars: data.substring(0, 100),
							charCodes: firstCharCodes,
							isWhitespaceAfterTrim: data.trim() === "",
							trimmedLength: data.trim().length,
							totalParseErrors: self.errorCount,
							fetchNumber: self.fetchCount
						});

					// Throttle console.error to prevent PM2 log flood
					// Only log 1st occurrence, then every 100th
					if (self.consecutiveErrors <= 1 || self.consecutiveErrors % 100 === 0) {
						console.error("MMM-PikudHaoref: Parse error (#" + self.errorCount + "): " + e.message +
							" | Raw[0:50]: " + JSON.stringify(data.substring(0, 50)));
					}

					if (self.lastResponseType !== "PARSE_ERROR") {
						self.logger.info("Response type changed: " + (self.lastResponseType || "FIRST_CHECK") + " -> PARSE_ERROR");
						self.lastResponseType = "PARSE_ERROR";
					}

					self.sendSocketNotification("ALERT_DATA", {
						type: "none",
						cities: []
					});
				}
			});
		});

		req.on("error", function (err) {
			self.errorCount++;
			self.consecutiveErrors++;

			self.logger.errorT("request-error",
				"HTTP request failed: " + err.message, {
					code: err.code,
					totalErrors: self.errorCount,
					consecutiveErrors: self.consecutiveErrors,
					fetchNumber: self.fetchCount
				});

			// Throttle console.error to prevent PM2 log flood
			if (self.consecutiveErrors === 1 || self.consecutiveErrors % 100 === 0) {
				console.error("MMM-PikudHaoref: Request error (x" + self.consecutiveErrors + "): " + err.message);
			}
		});

		req.on("timeout", function () {
			self.logger.warnT("timeout",
				"HTTP request timed out after 5000ms - destroying connection", {
					fetchNumber: self.fetchCount
				});
			req.destroy();
		});
	},

	getAlertType: function (category) {
		var categories = {
			1: "missiles",
			2: "radiologicalEvent",
			3: "earthQuake",
			4: "tsunami",
			5: "hostileAircraftIntrusion",
			6: "hazardousMaterials",
			7: "terroristInfiltration",
			10: "info",              // Pre-warning: "alerts expected in coming minutes" — NOT actionable
			13: "missiles"
		};
		var type = categories[category] || "unknown";
		if (!categories[category]) {
			this.logger.warn("Unknown alert category ID: " + category + " - defaulting to 'unknown'");
		} else {
			this.logger.debug("Category " + category + " resolved to alert type: " + type);
		}
		return type;
	},

	stop: function () {
		this.logger.info("=== MMM-PikudHaoref node_helper stopping ===", {
			totalFetches: this.fetchCount,
			totalErrors: this.errorCount,
			lastState: this.lastAlertState,
			lastResponseType: this.lastResponseType
		});
		this.logger.info("========================================");
		if (this.alertInterval) {
			clearInterval(this.alertInterval);
			this.alertInterval = null;
		}
	}
});
