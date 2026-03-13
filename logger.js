const fs = require("fs");
const path = require("path");

class RotatingLogger {
	constructor(options = {}) {
		this.logDir = options.logDir || path.join(__dirname, "logs");
		this.logFile = options.logFile || "pikudhaoref.log";
		this.maxSize = options.maxSize || 512 * 1024; // 512KB per file
		this.maxFiles = options.maxFiles || 3;         // 3 rotated files max

		// Throttle tracking: key -> { lastTime, suppressedCount }
		this._throttle = {};
		this._defaultThrottleMs = 60000; // 1 minute default

		// Ensure log directory exists
		try {
			if (!fs.existsSync(this.logDir)) {
				fs.mkdirSync(this.logDir, { recursive: true });
			}
		} catch (e) {
			console.error("RotatingLogger: Cannot create log dir:", e.message);
		}
	}

	_filePath() {
		return path.join(this.logDir, this.logFile);
	}

	_rotate() {
		try {
			var fp = this._filePath();
			if (!fs.existsSync(fp)) return;
			var stats = fs.statSync(fp);
			if (stats.size < this.maxSize) return;

			// Delete oldest rotated file
			var oldest = fp + "." + this.maxFiles;
			if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

			// Shift: .2->.3, .1->.2
			for (var i = this.maxFiles - 1; i >= 1; i--) {
				var src = fp + "." + i;
				var dst = fp + "." + (i + 1);
				if (fs.existsSync(src)) fs.renameSync(src, dst);
			}

			// Current -> .1
			fs.renameSync(fp, fp + ".1");
		} catch (e) {
			// Silently ignore rotation errors to avoid crashing the module
		}
	}

	_formatData(data) {
		if (data === undefined || data === null) return "";
		if (typeof data === "string") return " | " + data;
		try {
			return " | " + JSON.stringify(data);
		} catch (e) {
			return " | [unserializable]";
		}
	}

	_write(level, msg, data) {
		this._rotate();
		var ts = new Date().toISOString().replace("T", " ").replace("Z", "");
		var line = "[" + ts + "] [" + level.padEnd(5) + "] " + msg + this._formatData(data) + "\n";
		try {
			fs.appendFileSync(this._filePath(), line);
		} catch (e) {
			console.log("[PikudHaoref-Logger] " + line.trim());
		}
	}

	// Throttled write: only logs once per throttleMs for the same key
	_writeThrottled(level, throttleKey, throttleMs, msg, data) {
		var now = Date.now();
		var entry = this._throttle[throttleKey];

		if (entry && (now - entry.lastTime) < throttleMs) {
			entry.count++;
			return;
		}

		// Include suppressed count from previous window
		var finalMsg = msg;
		if (entry && entry.count > 0) {
			finalMsg += " (" + entry.count + " identical messages suppressed since last log)";
		}

		this._throttle[throttleKey] = { lastTime: now, count: 0 };
		this._write(level, finalMsg, data);
	}

	// Standard log methods - always write
	debug(msg, data) { this._write("DEBUG", msg, data); }
	info(msg, data)  { this._write("INFO", msg, data); }
	warn(msg, data)  { this._write("WARN", msg, data); }
	error(msg, data) { this._write("ERROR", msg, data); }

	// Throttled log methods - write at most once per interval
	// ms parameter is optional, defaults to 60s
	debugT(key, msg, data, ms) { this._writeThrottled("DEBUG", key, ms || this._defaultThrottleMs, msg, data); }
	infoT(key, msg, data, ms)  { this._writeThrottled("INFO", key, ms || this._defaultThrottleMs, msg, data); }
	warnT(key, msg, data, ms)  { this._writeThrottled("WARN", key, ms || this._defaultThrottleMs, msg, data); }
	errorT(key, msg, data, ms) { this._writeThrottled("ERROR", key, ms || this._defaultThrottleMs, msg, data); }
}

module.exports = RotatingLogger;
