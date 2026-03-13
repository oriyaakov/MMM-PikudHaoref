Module.register("MMM-PikudHaoref", {
	defaults: {
		pollingInterval: 3000,
		shelterTime: 90,
		alertDuration: 120000,
		// Map settings
		mapZoomNormal: 7.5,
		mapZoomAlert: 12,
		mapCenterNormal: [31.5, 34.8],       // Center of Israel
		mapCenterAlert: [31.5, 34.8],         // Override with your area coordinates
		mapWidth: "350px",
		mapHeight: "350px",
		cities: []
	},

	// Approximate coordinates for Israeli cities (for map markers)
	// Add your monitored cities here with their [lat, lon] coordinates
	cityCoords: {},

	start: function () {
		Log.info("[PikudHaoref] Module starting");
		Log.info("[PikudHaoref] Config: pollingInterval=" + this.config.pollingInterval + "ms, shelterTime=" + this.config.shelterTime + "s, alertDuration=" + this.config.alertDuration + "ms");
		Log.info("[PikudHaoref] Monitored cities: " + JSON.stringify(this.config.cities));
		Log.info("[PikudHaoref] Map: normalZoom=" + this.config.mapZoomNormal + ", alertZoom=" + this.config.mapZoomAlert);
		Log.info("[PikudHaoref] Known city coordinates: " + Object.keys(this.cityCoords).length + " cities");

		this.alertData = { type: "none", cities: [] };
		this.countdownTimer = null;
		this.alertTimestamp = null;
		this.countdownSeconds = 0;
		this.map = null;
		this.markers = [];
		this.isAlert = false;

		Log.info("[PikudHaoref] Sending START_POLLING to node_helper");
		this.sendSocketNotification("START_POLLING", this.config);
	},

	getStyles: function () {
		return [
			"https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
			"MMM-PikudHaoref.css"
		];
	},

	getScripts: function () {
		return [
			"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
		];
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "ALERT_DATA") {
			var hadAlert = this.isAlert;
			var hasAlert = payload.type !== "none";

			// Log every state-relevant notification (not every poll - only on changes or alerts)
			if (hasAlert || hadAlert !== hasAlert) {
				Log.info("[PikudHaoref] ALERT_DATA received: type='" + payload.type + "', cities=" + JSON.stringify(payload.cities) + ", hadAlert=" + hadAlert + ", hasAlert=" + hasAlert);
			}

			this.alertData = payload;

			if (hasAlert) {
				Log.info("[PikudHaoref] ALERT ACTIVE - type='" + payload.type + "', matched cities: " + JSON.stringify(payload.cities));
				Log.info("[PikudHaoref] All alert cities from API: " + JSON.stringify(payload.allCities));
				Log.info("[PikudHaoref] Alert title: '" + payload.title + "', category: " + payload.category);

				this.alertTimestamp = Date.now();
				Log.info("[PikudHaoref] Alert timestamp set to: " + new Date(this.alertTimestamp).toISOString());

				if (!hadAlert) {
					Log.info("[PikudHaoref] NEW alert (was not alerting before) - starting shelter countdown");
					this.startCountdown();
				} else {
					Log.info("[PikudHaoref] Continuing existing alert - NOT restarting countdown");
				}

				this.isAlert = true;
				Log.info("[PikudHaoref] Calling handleAlert() to update map and overlay");
				this.handleAlert();
			} else {
				// No alert in this poll - check if we should keep displaying
				var timeSinceAlert = this.alertTimestamp ? (Date.now() - this.alertTimestamp) : Infinity;
				var isRecent = this.alertTimestamp && timeSinceAlert < this.config.alertDuration;

				if (this.isAlert) {
					// Was alerting - should we stop?
					if (isRecent) {
						Log.info("[PikudHaoref] No alert in poll but still within alertDuration (" + Math.round(timeSinceAlert / 1000) + "s / " + (this.config.alertDuration / 1000) + "s) - keeping alert display active");
					} else {
						Log.info("[PikudHaoref] ALERT ENDED - no alert in poll and alertDuration expired (" + Math.round(timeSinceAlert / 1000) + "s >= " + (this.config.alertDuration / 1000) + "s)");
						Log.info("[PikudHaoref] Setting isAlert=false, calling handleAlertEnd()");
						this.isAlert = false;
						this.handleAlertEnd();
					}
				}
			}
		}
	},

	startCountdown: function () {
		var self = this;
		if (this.countdownTimer) {
			Log.info("[PikudHaoref] Clearing existing countdown timer before starting new one");
			clearInterval(this.countdownTimer);
		}
		this.countdownSeconds = this.config.shelterTime;
		Log.info("[PikudHaoref] Countdown started: " + this.countdownSeconds + " seconds to shelter");
		this.updateOverlay();
		this.countdownTimer = setInterval(function () {
			self.countdownSeconds--;
			if (self.countdownSeconds <= 0) {
				Log.info("[PikudHaoref] Countdown reached 0 - clearing timer, shelter time elapsed");
				clearInterval(self.countdownTimer);
				self.countdownTimer = null;
				self.countdownSeconds = 0;
			}
			self.updateOverlay();
		}, 1000);
	},

	getDom: function () {
		Log.info("[PikudHaoref] getDom() called - creating wrapper elements");
		var wrapper = document.createElement("div");
		wrapper.className = "pikud-haoref-wrapper";

		// Alert overlay above map (hidden by default)
		var overlay = document.createElement("div");
		overlay.id = "pikud-overlay-" + this.identifier;
		overlay.className = "pikud-overlay hidden";
		wrapper.appendChild(overlay);

		// Map container
		var mapContainer = document.createElement("div");
		mapContainer.id = "pikud-map-" + this.identifier;
		mapContainer.className = "pikud-map";
		mapContainer.style.width = this.config.mapWidth;
		mapContainer.style.height = this.config.mapHeight;
		wrapper.appendChild(mapContainer);

		// Initialize map after DOM is rendered
		var self = this;
		setTimeout(function () {
			Log.info("[PikudHaoref] 500ms timeout elapsed, calling initMap()");
			self.initMap();
		}, 500);

		return wrapper;
	},

	initMap: function () {
		var mapEl = document.getElementById("pikud-map-" + this.identifier);
		if (!mapEl) {
			Log.warn("[PikudHaoref] initMap() - map element not found in DOM (id: pikud-map-" + this.identifier + ")");
			return;
		}
		if (this.map) {
			Log.info("[PikudHaoref] initMap() - map already initialized, skipping");
			return;
		}

		Log.info("[PikudHaoref] Initializing Leaflet map with center=" + JSON.stringify(this.config.mapCenterNormal) + ", zoom=" + this.config.mapZoomNormal);

		this.map = L.map(mapEl, {
			zoomControl: false,
			attributionControl: false,
			dragging: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			keyboard: false,
			touchZoom: false
		}).setView(this.config.mapCenterNormal, this.config.mapZoomNormal);

		// Dark CartoDB tiles - strike map aesthetic
		L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
			subdomains: "abcd",
			maxZoom: 19
		}).addTo(this.map);

		Log.info("[PikudHaoref] Map initialized successfully with CartoDB dark tiles");

		// If there's already an active alert, handle it
		if (this.isAlert) {
			Log.info("[PikudHaoref] Map initialized while alert is active - calling handleAlert()");
			this.handleAlert();
		}
	},

	handleAlert: function () {
		if (!this.map) {
			Log.warn("[PikudHaoref] handleAlert() called but map is not initialized yet - skipping");
			return;
		}
		var self = this;

		// Zoom to alert area
		Log.info("[PikudHaoref] handleAlert() - flying map to alert center " + JSON.stringify(this.config.mapCenterAlert) + " zoom=" + this.config.mapZoomAlert);
		this.map.flyTo(this.config.mapCenterAlert, this.config.mapZoomAlert, {
			duration: 1.5
		});

		// Clear old markers
		Log.info("[PikudHaoref] Clearing " + this.markers.length + " old markers");
		this.clearMarkers();

		// Add pulsing markers for alerted cities
		var cities = this.alertData.cities || [];
		Log.info("[PikudHaoref] Adding markers for " + cities.length + " alert cities");

		cities.forEach(function (city) {
			var coords = self.cityCoords[city];
			if (coords) {
				Log.info("[PikudHaoref] Adding marker for '" + city + "' at [" + coords[0] + ", " + coords[1] + "]");
				var marker = L.marker(coords, {
					icon: L.divIcon({
						className: "alert-marker-icon",
						html: '<div class="alert-marker-pulse"></div><div class="alert-marker-dot"></div>',
						iconSize: [30, 30],
						iconAnchor: [15, 15]
					})
				}).addTo(self.map);

				// City name tooltip
				marker.bindTooltip(city, {
					permanent: true,
					direction: "top",
					className: "alert-city-tooltip",
					offset: [0, -15]
				});

				self.markers.push(marker);
			} else {
				Log.warn("[PikudHaoref] No coordinates found for city '" + city + "' - cannot place marker on map");
			}
		});

		Log.info("[PikudHaoref] Total markers placed: " + this.markers.length);

		// Show alert overlay
		this.updateOverlay();

		// Add red border to wrapper
		var wrapper = document.querySelector(".pikud-haoref-wrapper");
		if (wrapper) {
			wrapper.classList.add("alert-active");
			Log.info("[PikudHaoref] Added 'alert-active' class to wrapper (red border + glow)");
		} else {
			Log.warn("[PikudHaoref] Could not find .pikud-haoref-wrapper element to add alert-active class");
		}
	},

	handleAlertEnd: function () {
		if (!this.map) {
			Log.warn("[PikudHaoref] handleAlertEnd() called but map is not initialized - skipping");
			return;
		}

		// Zoom back to Israel view
		Log.info("[PikudHaoref] handleAlertEnd() - flying map back to normal view " + JSON.stringify(this.config.mapCenterNormal) + " zoom=" + this.config.mapZoomNormal);
		this.map.flyTo(this.config.mapCenterNormal, this.config.mapZoomNormal, {
			duration: 2
		});

		// Clear markers
		Log.info("[PikudHaoref] Clearing " + this.markers.length + " alert markers");
		this.clearMarkers();

		// Hide overlay
		var overlay = document.getElementById("pikud-overlay-" + this.identifier);
		if (overlay) {
			overlay.classList.add("hidden");
			overlay.innerHTML = "";
			Log.info("[PikudHaoref] Overlay hidden and cleared");
		} else {
			Log.warn("[PikudHaoref] Could not find overlay element to hide");
		}

		// Remove red border
		var wrapper = document.querySelector(".pikud-haoref-wrapper");
		if (wrapper) {
			wrapper.classList.remove("alert-active");
			Log.info("[PikudHaoref] Removed 'alert-active' class from wrapper");
		}
	},

	updateOverlay: function () {
		var overlay = document.getElementById("pikud-overlay-" + this.identifier);
		if (!overlay) {
			Log.warn("[PikudHaoref] updateOverlay() - overlay element not found");
			return;
		}

		var timeSinceAlert = this.alertTimestamp ? (Date.now() - this.alertTimestamp) : Infinity;
		var isRecent = this.alertTimestamp && timeSinceAlert < this.config.alertDuration;

		if (this.alertData.type === "none" && !isRecent) {
			if (!overlay.classList.contains("hidden")) {
				Log.info("[PikudHaoref] updateOverlay() - no alert and not recent, hiding overlay");
			}
			overlay.classList.add("hidden");
			overlay.innerHTML = "";
			return;
		}

		overlay.classList.remove("hidden");

		var alertTypeHebrew = this.getAlertTypeHebrew(this.alertData.type);
		var html = '<div class="overlay-header">\u26A0 \u05E6\u05D1\u05E2 \u05D0\u05D3\u05D5\u05DD \u26A0</div>';
		html += '<div class="overlay-type">' + alertTypeHebrew + '</div>';

		if (this.countdownSeconds > 0) {
			html += '<div class="overlay-countdown">';
			html += '<span class="overlay-countdown-num">' + this.countdownSeconds + '</span>';
			html += '<span class="overlay-countdown-label">\u05E9\u05E0\u05D9\u05D5\u05EA \u05DC\u05DE\u05D9\u05E7\u05DC\u05D8</span>';
			html += '</div>';
		} else if (isRecent) {
			html += '<div class="overlay-shelter">\u05D4\u05D9\u05E9\u05D0\u05E8\u05D5 \u05D1\u05DE\u05E8\u05D7\u05D1 \u05D4\u05DE\u05D5\u05D2\u05DF</div>';
		}

		overlay.innerHTML = html;

		// Log overlay state only on significant changes (not every countdown tick)
		if (this.countdownSeconds === this.config.shelterTime || this.countdownSeconds === 0) {
			Log.info("[PikudHaoref] updateOverlay() - type='" + this.alertData.type + "' (" + alertTypeHebrew + "), countdown=" + this.countdownSeconds + "s, isRecent=" + isRecent);
		}
	},

	clearMarkers: function () {
		this.markers.forEach(function (marker) {
			marker.remove();
		});
		this.markers = [];
	},

	getAlertTypeHebrew: function (type) {
		var types = {
			missiles: "\u05D9\u05E8\u05D9 \u05E8\u05E7\u05D8\u05D5\u05EA \u05D5\u05D8\u05D9\u05DC\u05D9\u05DD",
			radiologicalEvent: "\u05D0\u05D9\u05E8\u05D5\u05E2 \u05E8\u05D3\u05D9\u05D5\u05DC\u05D5\u05D2\u05D9",
			earthQuake: "\u05E8\u05E2\u05D9\u05D3\u05EA \u05D0\u05D3\u05DE\u05D4",
			tsunami: "\u05E6\u05D5\u05E0\u05D0\u05DE\u05D9",
			hostileAircraftIntrusion: "\u05D7\u05D3\u05D9\u05E8\u05EA \u05DB\u05DC\u05D9 \u05D8\u05D9\u05E1 \u05E2\u05D5\u05D9\u05DF",
			hazardousMaterials: "\u05D7\u05D5\u05DE\u05E8\u05D9\u05DD \u05DE\u05E1\u05D5\u05DB\u05E0\u05D9\u05DD",
			terroristInfiltration: "\u05D7\u05D3\u05D9\u05E8\u05EA \u05DE\u05D7\u05D1\u05DC\u05D9\u05DD",
			unknown: "\u05D4\u05EA\u05E8\u05E2\u05D4"
		};
		var result = types[type] || "\u05D4\u05EA\u05E8\u05E2\u05D4";

		// Log type resolution for debugging wrong visual effects
		if (type !== "none") {
			Log.info("[PikudHaoref] Alert type '" + type + "' resolved to Hebrew: '" + result + "'");
		}

		return result;
	}
});
