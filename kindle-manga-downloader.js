//==UserScript==
//@name         Kindle Manga Downloader
//@namespace    http://tampermonkey.net/
//@version      0.1.0
//@description  Download manga images from Amazon Kindle
//@author       You
//@match        https://read.amazon.co.jp/*
//@match        https://read.amazon.com/*
//@require      https://cdn.jsdelivr.net/npm/js-untar@2.0.0/build/dist/untar.min.js
//@require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
//@grant        GM_download
//@grant        GM_xmlhttpRequest
//@connect      cloudfront.net
//@run-at       document-end
//==/UserScript==

(function () {
	"use strict";

	//===== DEBUG MODE CONFIGURATION =====
	const DEBUG_MODE = false; //Set to false for full download
	const DEBUG_MAX_PAGE_REQUESTS = 3; //Only download first N page requests (each request = 2 pages)
	const DEBUG_MAX_IMAGES = 10; //Only download first N images
	//====================================

	/**
	 * DOWNLOAD PROCESS OVERVIEW:
	 *
	 * 1. First Request: Get Table of Contents (TOC)
	 *    - Make initial render request with startingPosition=0 or first position
	 *    - Parse TAR response to get: toc.json, manifest.json, metadata.json
	 *    - toc.json contains all chapter positions
	 *    - manifest.json contains CDN info and total page count
	 *    - metadata.json contains book title and metadata
	 *
	 * 2. Subsequent Requests: Download pages in chunks
	 *    - Amazon downloads pages in batches (numPage=2 means 2 pages per request)
	 *    - Each request returns:
	 *      - page_data_X_Y.json (page layout and image references)
	 *      - tokens_X_Y.json (position tokens)
	 *      - panels_X_Y.json (panel information)
	 *      - layout_data_X_Y.json (layout metadata)
	 *    - Loop: increment startingPosition until all pages downloaded
	 *
	 * 3. Image Downloads from CDN
	 *    - Parse page_data files to get imageReference values
	 *    - Map imageReference to CDN URLs from manifest.cdnResources
	 *    - Construct full URL: baseUrl + resource.url + "?" + authParameter
	 *    - Note: Images may be encrypted (manifest.cdn.encrypted=true)
	 *    - Download all images and bundle into ZIP
	 *
	 * CRITICAL REQUIREMENTS:
	 * - x-amz-rendering-token header (required for all requests)
	 * - revision ID (must match book version)
	 * - Proper viewport dimensions (width, height)
	 * - CDN auth parameters (expire after ~5 minutes)
	 */

	const LOG_LEVELS = {
		OKAY: { prefix: "✅", method: "log", color: "#4CAF50" },
		INFO: { prefix: "ℹ️", method: "info", color: "#2196F3" },
		WARNING: { prefix: "⚠️", method: "warn", color: "#FF9800" },
		ERROR: { prefix: "❌", method: "error", color: "#F44336" },
	};

	const log = {
		okay: (message, ...args) => {
			console.log(`%c${LOG_LEVELS.OKAY.prefix} ${message}`, `color: ${LOG_LEVELS.OKAY.color}; font-weight: bold`, ...args);
		},
		info: (message, ...args) => {
			console.info(`%c${LOG_LEVELS.INFO.prefix} ${message}`, `color: ${LOG_LEVELS.INFO.color}; font-weight: bold`, ...args);
		},
		warning: (message, ...args) => {
			console.warn(`%c${LOG_LEVELS.WARNING.prefix} ${message}`, `color: ${LOG_LEVELS.WARNING.color}; font-weight: bold`, ...args);
		},
		error: (message, ...args) => {
			console.error(`%c${LOG_LEVELS.ERROR.prefix} ${message}`, `color: ${LOG_LEVELS.ERROR.color}; font-weight: bold`, ...args);
		},
	};

	log.okay("Kindle Manga Downloader loaded");
	if (DEBUG_MODE) {
		log.warning(`DEBUG MODE ENABLED: Max ${DEBUG_MAX_PAGE_REQUESTS} page requests, Max ${DEBUG_MAX_IMAGES} images`);
	}

	let currentModal = null;
	let cachedBookInfo = null;
	let progressModal = null;

	//Script-scoped variables for frequently reused metadata-derived values
	let bookMetadata = null;
	let bookToc = null;
	let bookLocationMap = null;
	let bookLanguage = "en";
	let bookIsRTL = false;
	let bookCoverPosition = 0;

	/**
	 * Get the current Amazon domain (either read.amazon.co.jp or read.amazon.com).
	 * Returns null if not on a supported domain.
	 *
	 * @returns {string|null} The current Amazon domain or null if invalid.
	 */
	function getCurrentDomain() {
		const hostname = window.location.hostname;
		if (hostname === "read.amazon.co.jp") {
			return "read.amazon.co.jp";
		} else if (hostname === "read.amazon.com") {
			return "read.amazon.com";
		}
		return null;
	}

	/**
	 * Inject the CSS styles into the page.
	 *
	 * @returns {void}
	 */
	function injectModalStyles() {
		if (document.getElementById("kindle-dl-styles")) {
			return;
		}

		const style = document.createElement("style");
		style.id = "kindle-dl-styles";
		style.textContent = `
			.kindle-modal-overlay {
				position: fixed;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				background: rgba(0, 0, 0, 0.7);
				z-index: 999999;
				display: flex;
				align-items: center;
				justify-content: center;
				animation: fadeIn 0.2s ease;
			}

			@keyframes fadeIn {
				from { opacity: 0; }
				to { opacity: 1; }
			}

			.kindle-modal {
				background: #2d2d2d;
				border-radius: 8px;
				padding: 24px;
				max-width: 500px;
				max-height: 80vh;
				width: 90%;
				box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
				color: #fff;
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				display: flex;
				flex-direction: column;
			}

			.kindle-modal-title {
				font-size: 20px;
				font-weight: bold;
				margin: 0 0 16px 0;
				color: #ff9900;
				flex-shrink: 0;
			}

			.kindle-modal-content {
				font-size: 14px;
				line-height: 1.5;
				margin-bottom: 20px;
				overflow-y: auto;
				flex-grow: 1;
			}

			.kindle-modal-content-text {
				white-space: pre-wrap;
			}

			.kindle-modal-buttons {
				display: flex;
				justify-content: flex-end;
				gap: 12px;
				flex-shrink: 0;
			}

			.kindle-modal-button {
				border-radius: 5px;
				border: none;
				cursor: pointer;
				font-size: 14px;
				font-weight: 600;
				padding: 10px 20px;
			}

			.kindle-modal-button-primary {
				background: #ff9900;
				color: white;
			}

			.kindle-modal-button-primary:hover {
				background: #e68a00;
			}

			.kindle-modal-button-secondary {
				background: #444;
				color: white;
			}

			.kindle-modal-button-secondary:hover {
				background: #555;
			}

			.kindle-progress-section {
				margin: 16px 0;
			}

			.kindle-progress-label {
				font-size: 13px;
				color: #aaa;
				margin-bottom: 6px;
			}

			.kindle-progress-bar {
				background: #444;
				height: 24px;
				border-radius: 12px;
				overflow: hidden;
				position: relative;
			}

			.kindle-progress-fill {
				position: absolute;
				top: 0;
				left: 0;
				background: linear-gradient(90deg, #ff9900, #ffb84d);
				height: 100%;
				transition: width 0.3s ease;
				display: flex;
				align-items: center;
				justify-content: center;
				font-size: 12px;
				font-weight: bold;
				color: white;
			}

			.kindle-progress-text {
				position: absolute;
				top: 0;
				left: 0;
				width: 100%;
				text-align: center;
				line-height: 24px;
				font-size: 12px;
				font-weight: bold;
				color: white;
				text-shadow: 0 1px 2px rgba(0,0,0,0.5);
			}

			.kindle-status-list {
				max-height: 120px;
				overflow-y: auto;
				background: #1a1a1a;
				border-radius: 4px;
				padding: 12px;
				margin: 12px 0;
				font-family: 'Consolas', 'Monaco', monospace;
				font-size: 12px;
			}

			.kindle-status-item {
				margin: 4px 0;
				color: #bbb;
			}

			.kindle-status-item.success {
				color: #4caf50;
			}

			.kindle-status-item.error {
				color: #f44336;
			}

			.kindle-status-item.warning {
				color: #ff9800;
			}

			/* Download buttons */
			.kindle-download-button {
				position: fixed;
				top: 10px;
				right: 10px;
				z-index: 10000;
				padding: 10px 20px;
				background: #ff9900;
				color: white;
				border: none;
				border-radius: 5px;
				cursor: pointer;
				font-size: 14px;
				font-weight: bold;
				box-shadow: 0 2px 5px rgba(0,0,0,0.3);
				transition: opacity 0.2s ease;
			}

			.kindle-download-button:hover {
				background: #e68a00;
			}

			.kindle-status-button {
				position: fixed;
				top: 10px;
				right: 180px;
				z-index: 10000;
				padding: 10px 20px;
				background: #007bff;
				color: white;
				border: none;
				border-radius: 5px;
				cursor: pointer;
				font-size: 14px;
				font-weight: bold;
				box-shadow: 0 2px 5px rgba(0,0,0,0.3);
				transition: opacity 0.2s ease;
			}

			.kindle-status-button:hover {
				background: #0056b3;
			}

			.kindle-button-hidden {
				opacity: 0;
				pointer-events: none;
			}

			/* Format selection styles */
			.kindle-format-options {
				margin: 20px 0;
			}

			.kindle-format-option {
				background: #1a1a1a;
				border: 2px solid #444;
				border-radius: 8px;
				padding: 12px 16px;
				margin: 10px 0;
				cursor: pointer;
				transition: all 0.2s ease;
				display: flex;
				align-items: flex-start;
				gap: 12px;
			}

			.kindle-format-option:hover {
				background: #252525;
				border-color: #666;
			}

			.kindle-format-option.selected {
				background: #2d2d2d;
				border-color: #ff9900;
			}

			.kindle-format-option input[type="radio"] {
				margin-top: 2px;
				cursor: pointer;
				accent-color: #ff9900;
				width: 18px;
				height: 18px;
				flex-shrink: 0;
			}

			.kindle-format-option-content {
				flex: 1;
			}

			.kindle-format-option-title {
				font-weight: bold;
				color: #fff;
				font-size: 15px;
				margin-bottom: 4px;
			}

			.kindle-format-option-description {
				color: #aaa;
				font-size: 13px;
				line-height: 1.4;
			}

			.kindle-format-option-note {
				color: #ff9800;
				font-size: 12px;
				margin-top: 4px;
				font-style: italic;
			}

			.kindle-book-info {
				background: #1a1a1a;
				border-radius: 6px;
				padding: 12px;
				margin-bottom: 16px;
				font-size: 13px;
				line-height: 1.6;
			}

			.kindle-book-info-title {
				color: #ff9900;
				font-weight: bold;
				margin-bottom: 8px;
			}
		`;
		document.head.appendChild(style);
	}
	injectModalStyles();

	/**
	 * Show a modal with a title, content, and optional buttons.
	 *
	 * @param {string} title The title of the modal.
	 * @param {string|HTMLElement} content The content of the modal.
	 * @param {Array} buttons An array of button objects with text, type, and onClick properties.
	 * @returns {HTMLElement} The overlay element of the modal.
	 */
	function showModal(title, content, buttons = []) {
		closeModal(); //Close any existing modal

		const overlay = document.createElement("div");
		overlay.className = "kindle-modal-overlay";

		const modal = document.createElement("div");
		modal.className = "kindle-modal";

		const titleEl = document.createElement("div");
		titleEl.className = "kindle-modal-title";
		titleEl.textContent = title;

		const contentEl = document.createElement("div");
		contentEl.className = "kindle-modal-content";
		if (typeof content === "string") {
			contentEl.classList.add("kindle-modal-content-text");
			contentEl.textContent = content;
		} else {
			contentEl.appendChild(content);
		}

		modal.appendChild(titleEl);
		modal.appendChild(contentEl);

		if (buttons.length > 0) {
			const buttonsEl = document.createElement("div");
			buttonsEl.className = "kindle-modal-buttons";

			buttons.forEach((btn) => {
				const button = document.createElement("button");
				button.className = `kindle-modal-button kindle-modal-button-${btn.type || "secondary"}`;
				button.textContent = btn.text;
				button.onclick = () => {
					closeModal();
					if (btn.onClick) btn.onClick();
				};
				buttonsEl.appendChild(button);
			});

			modal.appendChild(buttonsEl);
		}

		overlay.appendChild(modal);
		document.body.appendChild(overlay);
		currentModal = overlay;
		return overlay;
	}

	/**
	 * Show a confirmation modal with a title and content.
	 *
	 * @param {string} title The title of the confirmation modal.
	 * @param {string|HTMLElement} content The content of the confirmation modal.
	 * @returns {Promise<boolean>} A promise that resolves to true if the user confirms, false otherwise.
	 */
	function showConfirm(title, content) {
		return new Promise((resolve) => {
			showModal(title, content, [
				{ text: "Cancel", type: "secondary", onClick: () => resolve(false) },
				{ text: "Continue", type: "primary", onClick: () => resolve(true) },
			]);
		});
	}

	/**
	 * Show a format selection modal for choosing download format (ZIP, CBZ, EPUB).
	 *
	 * @param {Object} bookInfo Object containing bookTitle, totalLocations, estimatedRequests, chapters
	 * @returns {Promise<string|null>} A promise that resolves to the selected format ('zip', 'cbz', 'epub') or null if cancelled
	 */
	function showFormatSelectionModal(bookInfo) {
		return new Promise((resolve) => {
			const contentEl = document.createElement("div");

			//Book information section
			const infoSection = document.createElement("div");
			infoSection.className = "kindle-book-info";
			infoSection.innerHTML = `
				<div class="kindle-book-info-title">${bookInfo.bookTitle}</div>
				<div>Total locations: ${bookInfo.totalLocations}</div>
				<div>Estimated requests: ${bookInfo.estimatedRequests}</div>
				<div>Chapters: ${bookInfo.chapters}</div>
			`;
			contentEl.appendChild(infoSection);

			//Format selection label
			const label = document.createElement("div");
			label.textContent = "Select output format:";
			label.style.marginBottom = "8px";
			label.style.fontWeight = "bold";
			contentEl.appendChild(label);

			//Format options container
			const optionsContainer = document.createElement("div");
			optionsContainer.className = "kindle-format-options";

			const formats = [
				{
					value: "zip",
					title: "ZIP Archive",
					description: "Simple compressed archive of all images",
					note: null,
				},
				{
					value: "cbz",
					title: "CBZ (Comic Book Archive)",
					description: "Comic book format with metadata, compatible with most comic readers.",
					note: "⚠️ No chapter navigation support\n⚠️ Does not support double page spreads",
				},
				{
					value: "epub",
					title: "EPUB (Electronic Publication)",
					description: "Ebook format with full chapter navigation and metadata.",
					note: "✅ Chapter navigation\n✅ Double page spreads",
				},
			];

			let selectedFormat = "cbz"; //Default selection

			formats.forEach((format) => {
				const option = document.createElement("label");
				option.className = "kindle-format-option" + (format.value === selectedFormat ? " selected" : "");

				const radio = document.createElement("input");
				radio.type = "radio";
				radio.name = "format";
				radio.value = format.value;
				radio.checked = format.value === selectedFormat;

				const content = document.createElement("div");
				content.className = "kindle-format-option-content";

				const title = document.createElement("div");
				title.className = "kindle-format-option-title";
				title.textContent = format.title;

				const description = document.createElement("div");
				description.className = "kindle-format-option-description";
				description.textContent = format.description;

				content.appendChild(title);
				content.appendChild(description);

				if (format.note) {
					const note = document.createElement("div");
					note.className = "kindle-format-option-note";
					note.textContent = format.note;
					content.appendChild(note);
				}

				option.appendChild(radio);
				option.appendChild(content);

				//Update selection on click
				option.addEventListener("click", () => {
					selectedFormat = format.value;
					//Update visual selection
					optionsContainer.querySelectorAll(".kindle-format-option").forEach((opt) => {
						opt.classList.remove("selected");
					});
					option.classList.add("selected");
				});

				optionsContainer.appendChild(option);
			});

			contentEl.appendChild(optionsContainer);

			//Warning message
			const warning = document.createElement("div");
			warning.style.marginTop = "16px";
			warning.style.color = "#aaa";
			warning.style.fontSize = "12px";
			warning.textContent = "This may take a few minutes. Continue?";
			contentEl.appendChild(warning);

			showModal("📖 Ready to Download", contentEl, [
				{ text: "Cancel", type: "secondary", onClick: () => resolve(null) },
				{ text: "Download", type: "primary", onClick: () => resolve(selectedFormat) },
			]);
		});
	}

	/**
	 * Create a progress modal with a title.
	 *
	 * @param {string} title The title of the progress modal.
	 * @returns {Object} An object containing the overlay element, content element, and methods to update progress and add status messages.
	 */
	function createProgressModal(title) {
		closeModal();

		const overlay = document.createElement("div");
		overlay.className = "kindle-modal-overlay";

		const modal = document.createElement("div");
		modal.className = "kindle-modal";

		const titleEl = document.createElement("div");
		titleEl.className = "kindle-modal-title";
		titleEl.textContent = title;

		const contentEl = document.createElement("div");
		contentEl.className = "kindle-modal-content";
		contentEl.id = "kindle-progress-content";

		modal.appendChild(titleEl);
		modal.appendChild(contentEl);
		overlay.appendChild(modal);
		document.body.appendChild(overlay);
		currentModal = overlay;

		//Helper to normalize step name to consistent ID
		const normalizeStepId = (step) => {
			return step
				.replace(/[^\w\s]/g, "") //Remove emoji and special chars
				.trim()
				.toLowerCase()
				.replace(/\s+/g, "-"); //Replace spaces with hyphens
		};

		//Helper to limit status messages (keep only last N items)
		const limitStatusMessages = (statusList, maxItems = 20) => {
			while (statusList.children.length > maxItems) {
				statusList.removeChild(statusList.firstChild);
			}
		};

		return {
			overlay,
			contentEl,
			updateProgress: (step, current, total, statusMessage) => {
				const percent = total > 0 ? Math.round((current / total) * 100) : 0;
				const stepId = normalizeStepId(step);

				let section = contentEl.querySelector(`#progress-${stepId}`);
				if (!section) {
					section = document.createElement("div");
					section.id = `progress-${stepId}`;
					section.className = "kindle-progress-section";
					section.innerHTML = `
						<div class="kindle-progress-label">${step}</div>
						<div class="kindle-progress-bar">
							<div class="kindle-progress-fill" style="width: 0%"></div>
							<div class="kindle-progress-text">0%</div>
						</div>
						<div class="kindle-status-list"></div>
					`;
					contentEl.appendChild(section);
				}

				//Update label in case step text changed (emoji variations)
				const label = section.querySelector(".kindle-progress-label");
				if (label) {
					label.textContent = step;
				}

				const fill = section.querySelector(".kindle-progress-fill");
				const text = section.querySelector(".kindle-progress-text");
				if (fill) {
					fill.style.width = `${percent}%`;
				}
				if (text) {
					text.textContent = `${percent}% (${current}/${total})`;
				}

				if (statusMessage) {
					const statusList = section.querySelector(".kindle-status-list");
					const item = document.createElement("div");
					item.className = "kindle-status-item";
					if (statusMessage.startsWith("[OKAY] ")) {
						item.className += " success";
					} else if (statusMessage.startsWith("[ERROR] ")) {
						item.className += " error";
					} else if (statusMessage.startsWith("[WARNING] ")) {
						item.className += " warning";
					}
					item.textContent = statusMessage;
					statusList.appendChild(item);
					limitStatusMessages(statusList, 15); //Keep only last 15 messages
					statusList.scrollTop = statusList.scrollHeight;
				}
			},
			addStatus: (message, type = "info") => {
				const statusContainer =
					contentEl.querySelector(".kindle-status-list") ||
					(() => {
						const container = document.createElement("div");
						container.className = "kindle-status-list";
						contentEl.appendChild(container);
						return container;
					})();

				const item = document.createElement("div");
				item.className = `kindle-status-item ${type}`;
				item.textContent = message;
				statusContainer.appendChild(item);
				limitStatusMessages(statusContainer, 15); //Keep only last 15 messages
				statusContainer.scrollTop = statusContainer.scrollHeight;
			},
			close: closeModal,
		};
	}

	/**
	 * Close the currently open modal.
	 */
	function closeModal() {
		if (currentModal) {
			currentModal.remove();
			currentModal = null;
		}
	}

	/**
	 * Add a "Download Book" button to the page in the top right.
	 *
	 * @returns {void}
	 */
	function addDownloadButton() {
		const button = document.createElement("button");
		button.textContent = "Download Book";
		button.className = "kindle-download-button";
		button.addEventListener("click", downloadBook);
		document.body.appendChild(button);

		//Also add a status check button for debugging
		const statusButton = document.createElement("button");
		statusButton.textContent = "🔍 Check Status";
		statusButton.className = "kindle-status-button";
		statusButton.addEventListener("click", checkStatus);
		document.body.appendChild(statusButton);

		//Observe #readerChromeTop visibility and hide buttons when it's hidden
		const observeChromeTop = () => {
			const chromeTop = document.getElementById("readerChromeTop");
			if (!chromeTop) {
				//If element doesn't exist yet, try again later
				setTimeout(observeChromeTop, 500);
				return;
			}

			const updateButtonVisibility = () => {
				const isHidden =
					chromeTop.style.display === "none" ||
					chromeTop.style.visibility === "hidden" ||
					window.getComputedStyle(chromeTop).display === "none" ||
					window.getComputedStyle(chromeTop).visibility === "hidden";

				if (isHidden) {
					button.classList.add("kindle-button-hidden");
					statusButton.classList.add("kindle-button-hidden");
				} else {
					button.classList.remove("kindle-button-hidden");
					statusButton.classList.remove("kindle-button-hidden");
				}
			};

			//Initial check
			updateButtonVisibility();

			//Watch for changes
			const observer = new MutationObserver(updateButtonVisibility);
			observer.observe(chromeTop, {
				attributes: true,
				attributeFilter: ["style", "class"],
			});
		};

		observeChromeTop();
	}

	/**
	 * Check the status of all required data for downloading the book and display a comprehensive report in a modal.
	 *
	 * @returns {void}
	 */
	function checkStatus() {
		log.info("Kindle Downloader Status Check");

		const bookInfo = getBookInfo();
		const asin = extractAsinFromPage();
		const revision = extractRevision();
		const token = extractRenderingToken();

		let status = "";

		if (bookInfo) {
			status += `✅ Book Info: Found\n`;
			status += `   Title: ${bookInfo.title || "N/A"}\n`;
			status += `   ASIN: ${bookInfo.asin || "N/A"}\n`;
			status += `   Revision: ${bookInfo.contentGuid || "N/A"}\n`;
			status += `   Content Type: ${bookInfo.bookContentType || "N/A"}\n`;
			if (bookInfo.karamelToken) {
				const expiresAt = new Date(bookInfo.karamelToken.expiresAt);
				const isExpired = Date.now() > bookInfo.karamelToken.expiresAt;
				status += `   Token: ${isExpired ? "⚠️ EXPIRED" : "✅ Valid"}\n`;
				status += `   Expires: ${expiresAt.toLocaleString()}\n`;
			}
		} else {
			status += `❌ Book Info: Not Found\n`;
		}

		status += `\n${asin ? "✅ " : "❌ "} ASIN: ${asin || "Not found"}\n`;
		status += `${revision ? "✅ " : "❌ "} Revision: ${revision || "Not found"}\n`;
		status += `${token ? "✅ " : "❌ "} Rendering Token: ${token ? "Found (" + token.substring(0, 20) + "...)" : "Not found"}\n`;

		const allReady = bookInfo && asin && revision && token;
		status += `\n${allReady ? "🎉 Ready to download!" : "⚠️ Missing required data"}`;

		showModal("📊 Status Report", status, [{ text: "Close", type: "primary" }]);
		log.info(status);

		if (bookInfo) {
			log.info("Full Book Info:", bookInfo);
		}
	}

	/**
	 * Parse a TAR response and extract JSON files.
	 * This function uses the js-untar library to parse the TAR file and extracts JSON content from the files.
	 * It skips any PaxHeaders (metadata files) and returns a map of file names to their parsed JSON content.
	 *
	 * @param {ArrayBuffer} arrayBuffer The TAR response as an ArrayBuffer.
	 * @returns {Promise<Object>} A map of file names to parsed JSON objects.
	 */
	async function parseTarResponse(arrayBuffer) {
		try {
			const files = await untar(arrayBuffer);
			const fileMap = {};

			for (const file of files) {
				//Skip PaxHeaders (metadata files)
				if (file.name.includes("PaxHeaders")) {
					continue;
				}

				//Convert file blob to text for JSON files
				const text = await file.blob.text();
				fileMap[file.name] = JSON.parse(text);
				log.info(`Parsed: ${file.name}`);
			}

			return fileMap;
		} catch (error) {
			log.error("Error parsing TAR:", error);
			throw error;
		}
	}

	/**
	 * Fetch pages from the render endpoint.
	 *
	 * @param {string} asin The ASIN of the book.
	 * @param {string} revision The revision of the book.
	 * @param {string} renderingToken The rendering token for authentication.
	 * @param {number} startingPosition The starting position for fetching pages.
	 * @param {number} numPages The number of pages to fetch.
	 * @param {boolean} includeLocationMap Whether to include the location map.
	 * @returns {Promise<ArrayBuffer>} The fetched page data as an ArrayBuffer.
	 */
	async function fetchPages(asin, revision, renderingToken, startingPosition, numPages = 2, includeLocationMap = false) {
		//There are some hard coded parameters here that eventually will need to be tweaked or made configurable as features are added.
		const params = new URLSearchParams({
			version: "3.0",
			asin: asin,
			contentType: "FullBook",
			revision: revision,
			fontFamily: "Bookerly",
			fontSize: "4.95",
			lineHeight: "1.4",
			dpi: "160",
			height: "808",
			width: "2560",
			marginBottom: "0",
			marginLeft: "9",
			marginRight: "9",
			marginTop: "0",
			maxNumberColumns: "2",
			theme: "dark",
			packageType: "TAR",
			encryptionVersion: "NONE",
			numPage: String(numPages),
			skipPageCount: "0",
			startingPosition: String(startingPosition),
			bundleImages: "false",
		});

		//Only include locationMap when fetching TOC
		if (includeLocationMap) {
			params.set("locationMap", "true");
		}

		const domain = getCurrentDomain();
		if (!domain) {
			throw new Error("Invalid domain. This tool only works on read.amazon.co.jp or read.amazon.com");
		}
		const renderUrl = `https://${domain}/renderer/render?${params.toString()}`;
		log.info(`Fetching position ${startingPosition}...`);

		const response = await fetch(renderUrl, {
			credentials: "include",
			headers: {
				Accept: "application/x-tar",
				"x-amz-rendering-token": renderingToken,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		return await response.arrayBuffer();
	}

	/**
	 * Download the book by fetching pages, parsing them, and queueing images for download.
	 *
	 * @returns {Promise<void>}
	 */
	async function downloadBook() {
		try {
			log.info("Starting book download...");

			const renderingToken = extractRenderingToken();
			if (!renderingToken) {
				showModal("[ERROR]", "Could not find rendering token. Make sure the reader is loaded.", [{ text: "OK", type: "primary" }]);
				return;
			}

			const revision = extractRevision();
			if (!revision) {
				showModal("[ERROR]", "Could not find book revision. Make sure the reader is loaded.", [{ text: "OK", type: "primary" }]);
				return;
			}

			//Extract ASIN from current page
			const asin = extractAsinFromPage();
			if (!asin) {
				showModal("[ERROR]", "Could not find book ASIN. Make sure you are on a book page.", [{ text: "OK", type: "primary" }]);
				return;
			}

			//Step 1: Fetch TOC and metadata to understand book structure
			log.info("Step 1: Fetching Table of Contents...");
			progressModal = createProgressModal("📥 Downloading Manga");
			progressModal.addStatus("📖 Fetching Table of Contents...", "info");

			const tocBuffer = await fetchPages(asin, revision, renderingToken, 0, 2, true);
			const tocFiles = await parseTarResponse(tocBuffer);

			const toc = tocFiles["toc.json"];
			const metadata = tocFiles["metadata.json"];
			const locationMap = tocFiles["location_map.json"];
			const initialManifest = tocFiles["manifest.json"];

			//Store metadata-derived values in script scope for reuse across functions
			bookMetadata = metadata;
			bookToc = toc;
			bookLocationMap = locationMap;

			//Detect language
			if (bookMetadata.lang) {
				bookLanguage = bookMetadata.lang;
			} else if (bookMetadata.language) {
				bookLanguage = bookMetadata.language;
			}

			//Detect reading direction from metadata (RTL for manga)
			bookIsRTL = bookMetadata.progressionDirection === "rtl" || bookMetadata.direction === "rtl";

			//Get cover position
			bookCoverPosition = bookMetadata?.coverPosistion ?? bookMetadata?.coverPosition ?? 0;

			progressModal.addStatus("[OKAY] Table of Contents loaded", "success");
			log.info("Book Info:");
			log.info("  Title:", bookMetadata.bookTitle);
			log.info("  Authors:", bookMetadata.authors);
			log.info("  First Position:", bookMetadata.firstPositionId);
			log.info("  Last Position:", bookMetadata.lastPositionId);
			log.info("  Total Locations:", bookLocationMap.locations.length);
			bookToc.forEach((chapter) => {
				log.info(`    - ${chapter.label} (position ${chapter.tocPositionId})`);
			});

			//Step 2: Calculate how many requests we need
			const totalLocations = bookLocationMap.locations.length;
			const pagesPerRequest = 2;
			const estimatedRequests = Math.ceil(totalLocations / pagesPerRequest);

			log.info(`Download Plan:`);
			log.info(`  Total locations: ${totalLocations}`);
			log.info(`  Pages per request: ${pagesPerRequest}`);
			log.info(`  Estimated requests: ${estimatedRequests}`);

			progressModal.close();
			const selectedFormat = await showFormatSelectionModal({
				bookTitle: bookMetadata.bookTitle,
				totalLocations: totalLocations,
				estimatedRequests: estimatedRequests,
				chapters: bookToc.length,
			});

			if (!selectedFormat) {
				log.info("Download cancelled by user");
				return;
			}

			log.info(`User selected format: ${selectedFormat}`);

			progressModal = createProgressModal("📥 Downloading Manga");

			//Step 3: Download all pages
			log.info("Step 2: Downloading all pages...");
			const allPageData = [];
			const allCdnResources = new Map();
			let latestManifest = initialManifest;

			//Collect resources from initial manifest
			if (initialManifest && initialManifest.cdnResources) {
				initialManifest.cdnResources.forEach((resource) => {
					allCdnResources.set(resource.url, resource);
				});
			}

			//We already have the first batch from the TOC request
			if (tocFiles["page_data_0_1.json"]) {
				allPageData.push(...tocFiles["page_data_0_1.json"]);
				progressModal.updateProgress("📄 Downloading Pages", 1, estimatedRequests, "✅ Pages 0-1 downloaded");
				log.okay(`Downloaded pages 0-1 (from TOC request) - ${allPageData.length} pages total`);
			}

			log.info(`Starting loop from position index 2 to ${totalLocations}, stepping by ${pagesPerRequest}...`);

			//Download remaining pages using location map positions
			let requestCount = 1;
			const maxRequests = DEBUG_MODE ? DEBUG_MAX_PAGE_REQUESTS : totalLocations;

			for (let posIndex = 2; posIndex < totalLocations; posIndex += pagesPerRequest) {
				if (DEBUG_MODE && requestCount >= maxRequests) {
					progressModal.addStatus(`🐛 DEBUG MODE: Stopping after ${requestCount} requests`, "warning");
					log.warning(`DEBUG MODE: Stopping after ${requestCount} requests`);
					break;
				}
				requestCount++;
				const startPos = bookLocationMap.locations[posIndex];

				try {
					const pageBuffer = await fetchPages(asin, revision, renderingToken, startPos, pagesPerRequest);
					const pageFiles = await parseTarResponse(pageBuffer);

					//Find the page_data file
					const pageDataFile = Object.keys(pageFiles).find((name) => name.startsWith("page_data_"));
					if (pageDataFile && pageFiles[pageDataFile]) {
						const pagesAdded = pageFiles[pageDataFile].length;
						allPageData.push(...pageFiles[pageDataFile]);
						progressModal.updateProgress(
							"📄 Downloading Pages",
							requestCount,
							estimatedRequests,
							`✅ Pages ${posIndex}-${Math.min(posIndex + pagesPerRequest - 1, totalLocations - 1)} (+${pagesAdded})`,
						);
						log.okay(`Downloaded pages ${posIndex}-${Math.min(posIndex + pagesPerRequest - 1, totalLocations - 1)} (added ${pagesAdded} pages, ${allPageData.length} total pages so far)`);
					} else {
						progressModal.addStatus(`⚠️ No page_data at position ${startPos}`, "warning");
						log.warning(`No page_data file found for position ${startPos}`);
					}

					//Update manifest if available
					if (pageFiles["manifest.json"]) {
						latestManifest = pageFiles["manifest.json"];
						if (latestManifest.cdnResources) {
							latestManifest.cdnResources.forEach((resource) => {
								allCdnResources.set(resource.url, resource);
							});
						}
					}

					await new Promise((resolve) => setTimeout(resolve, 100));
				} catch (error) {
					progressModal.addStatus(`❌ Failed at position ${startPos}`, "error");
					log.error(`Failed to download pages at position ${startPos}:`, error);
				}
			}

			progressModal.addStatus(`✅ Downloaded ${allPageData.length} total pages`, "success");
			log.okay(`Loop complete. Downloaded all page data: ${allPageData.length} pages total`);
			log.okay(`Collected ${allCdnResources.size} unique CDN resources`);

			//Step 4: Download images from CDN
			log.info("Step 3: Downloading images from CDN...");
			const bookInfo = getBookInfo();

			const mergedManifest = {
				...latestManifest,
				cdnResources: Array.from(allCdnResources.values()),
			};

			await downloadImages(mergedManifest, allPageData, bookInfo.karamelToken, selectedFormat);
		} catch (error) {
			if (progressModal) progressModal.close();
			log.error("Download failed:", error);
			showModal("❌ Download Failed", `Error: ${error.message}`, [{ text: "OK", type: "primary" }]);
		}
	}

	/**
	 * Generate ComicInfo.xml metadata for CBZ format.
	 * This XML file contains metadata about the comic/manga according to the ComicInfo schema.
	 *
	 * @param {number} pageCount The total number of pages in the book.
	 * @returns {string} The ComicInfo.xml content as a string.
	 *
	 * @see https://anansi-project.github.io/docs/comicinfo/documentation
	 */
	function generateComicInfoXML(pageCount) {
		/**
		 * Escape XML special characters to prevent malformed XML.
		 * @param {string} str The string to escape.
		 * @returns {string} The escaped string.
		 */
		function escapeXML(str) {
			if (!str) {
				return "";
			}
			return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
		}

		//Extract metadata fields.
		const title = escapeXML(bookMetadata.bookTitle || "Unknown Title");

		//Handle authors - can be a string or array
		let authors = "";
		if (bookMetadata.authors) {
			if (Array.isArray(bookMetadata.authors)) {
				authors = bookMetadata.authors.map(escapeXML).join(", ");
			} else {
				authors = escapeXML(bookMetadata.authors);
			}
		}

		//Build the XML
		let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
		xml += '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n';

		//Required/recommended fields
		xml += `  <Title>${title}</Title>\n`;

		if (authors) {
			xml += `  <Writer>${authors}</Writer>\n`;
		}

		xml += `  <PageCount>${pageCount}</PageCount>\n`;
		xml += `  <Manga>Yes</Manga>\n`; //TODO: Make this a variable in the future in the case of non-manga style comic books.
		xml += `  <LanguageISO>${escapeXML(bookLanguage)}</LanguageISO>\n`;

		//Publisher and source information
		//TODO: Hard coded for now, lets try to fix this in the future.
		xml += `  <Publisher>Amazon Kindle</Publisher>\n`;
		xml += `  <Notes>Downloaded from Amazon Kindle. Downloaded with Kindle Manga Downloader.</Notes>\n`;

		//Add ASIN if available
		if (bookMetadata.asin) {
			//TODO: Fix domain selection.
			xml += `  <Web>https://www.amazon.com/dp/${escapeXML(bookMetadata.asin)}</Web>\n`;
		}

		//Optional: Add series information if we can extract it from TOC or metadata
		//Series name might be in the title
		if (bookMetadata.seriesName) {
			xml += `  <Series>${escapeXML(bookMetadata.seriesName)}</Series>\n`;
		}

		//Optional: Add volume number if available
		if (bookMetadata.volumeNumber) {
			xml += `  <Volume>${escapeXML(bookMetadata.volumeNumber)}</Volume>\n`;
		}

		//Format - always Manga for this downloader
		//TODO: Make this a variable in the future in the case of non-manga style comic books.
		xml += `  <Format>Manga</Format>\n`;

		//Black and White - most manga is B&W, but we don't know for sure.
		//Could be enhanced to detect from image analysis
		xml += `  <BlackAndWhite>Unknown</BlackAndWhite>\n`;

		//Pages section - could be enhanced to include page type information
		//For now, we'll keep it simple and just use the PageCount field above
		//Future enhancement: add <Pages> section with page type for each page

		xml += "</ComicInfo>\n";

		return xml;
	}

	/**
	 * Generate CBZ (Comic Book Archive) format from a ZIP containing images.
	 * CBZ is essentially a ZIP file with:
	 * - ComicInfo.xml metadata at the root
	 * - Images with sequential naming (page_001.ext, page_002.ext, etc.)
	 *
	 * @param {JSZip} sourceZip The source ZIP containing images with original filenames.
	 * @returns {Promise<JSZip>} A new JSZip instance formatted as CBZ.
	 */
	async function generateCBZ(sourceZip) {
		try {
			log.info("Generating CBZ format...");
			progressModal.addStatus("📚 Converting to CBZ format...", "info");

			//Create a new ZIP for CBZ.
			const cbzZip = new JSZip();

			//Step 1: Extract and sort images from source ZIP.
			const imageFiles = [];
			const fileNames = Object.keys(sourceZip.files);

			log.info(`CBZ: Found ${fileNames.length} files in source ZIP`);

			for (const fileName of fileNames) {
				const file = sourceZip.files[fileName];
				if (!file.dir) {
					//Extract pageIndex from filename (format: page_XXX_elementId.ext)
					const match = fileName.match(/page_(\d+)_.*\.(png|jpg|jpeg|webp|gif)$/i);
					if (match) {
						try {
							const pageIndex = parseInt(match[1], 10);
							const extension = match[2].toLowerCase();
							const data = await file.async("arraybuffer");

							imageFiles.push({
								pageIndex: pageIndex,
								extension: extension,
								data: data,
								originalName: fileName,
							});
							log.info(`CBZ: Extracted ${fileName}`);
						} catch (extractError) {
							log.error(`CBZ: Failed to extract ${fileName}:`, extractError);
							progressModal.addStatus(`⚠️ Failed to extract ${fileName}`, "warning");
						}
					} else {
						log.warning(`CBZ: Skipping non-image file: ${fileName}`);
					}
				}
			}

			if (imageFiles.length === 0) {
				throw new Error("No valid image files found in source ZIP");
			}

			//Sort by pageIndex to ensure correct reading order.
			imageFiles.sort((a, b) => a.pageIndex - b.pageIndex);

			log.info(`CBZ: Processing ${imageFiles.length} images`);

			//Step 2: Add images with sequential naming.
			imageFiles.forEach((img, index) => {
				const sequentialNumber = index + 1;
				const newFileName = `page_${String(sequentialNumber).padStart(3, "0")}.${img.extension}`;
				cbzZip.file(newFileName, img.data);
				log.info(`CBZ: Added ${newFileName} (from ${img.originalName})`);
			});

			progressModal.addStatus(`✅ Renamed ${imageFiles.length} images sequentially`, "success");
			log.okay(`CBZ: Added ${imageFiles.length} images with sequential naming`);

			//Step 3: Generate and add ComicInfo.xml.
			try {
				const comicInfoXML = generateComicInfoXML(imageFiles.length);
				cbzZip.file("ComicInfo.xml", comicInfoXML);
				log.okay(`CBZ: ComicInfo.xml generated (${comicInfoXML.length} bytes)`);
			} catch (xmlError) {
				log.error("CBZ: Failed to generate ComicInfo.xml:", xmlError);
				progressModal.addStatus("⚠️ Failed to generate ComicInfo.xml", "warning");
				// Continue anyway, CBZ will work without it
			}

			progressModal.addStatus("✅ Added ComicInfo.xml metadata", "success");
			log.okay("CBZ: Added ComicInfo.xml");

			return cbzZip;
		} catch (error) {
			log.error("CBZ: Generation failed:", error);
			progressModal.addStatus(`❌ CBZ generation failed: ${error.message}`, "error");
			throw error;
		}
	}

	/**
	 * Generate container.xml for EPUB format.
	 * This file tells EPUB readers where to find the content.opf file.
	 *
	 * @returns {string} The container.xml content.
	 */
	function generateContainerXML() {
		return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
	<rootfiles>
		<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
	</rootfiles>
</container>`;
	}

	/**
	 * Generate content.opf for EPUB format.
	 * This is the main package document that contains metadata, manifest, and spine.
	 *
	 * @param {Array} imageFiles Array of image file objects with {filename, extension} properties.
	 * @returns {string} The content.opf content.
	 */
	function generateContentOPF(imageFiles) {
		/**
		 * Escape XML special characters.
		 * @param {string} str The string to escape.
		 * @returns {string} The escaped string.
		 */
		function escapeXML(str) {
			if (!str) return "";
			return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
		}

		const title = escapeXML(bookMetadata.bookTitle || "Unknown Title");
		let authors = "";
		if (bookMetadata.authors) {
			if (Array.isArray(bookMetadata.authors)) {
				authors = bookMetadata.authors.map(escapeXML).join(", ");
			} else {
				authors = escapeXML(bookMetadata.authors);
			}
		}

		//Generate a unique identifier (use ASIN if available, otherwise generate UUID)
		const identifier = bookMetadata.asin || `uuid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		//Use script-scoped language and RTL values set in downloadBook

		let opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID">
	<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
		<dc:title>${title}</dc:title>
		<dc:identifier id="BookID">${escapeXML(identifier)}</dc:identifier>
		<dc:language>${escapeXML(bookLanguage)}</dc:language>`;

		if (authors) {
			opf += `
		<dc:creator>${authors}</dc:creator>`;
		}

		opf += `
		<dc:publisher>Amazon Kindle</dc:publisher>
		<dc:rights>All rights reserved</dc:rights>
		<meta property="dcterms:modified">${new Date().toISOString().split(".")[0]}Z</meta>
		<meta property="rendition:layout">pre-paginated</meta>
		<meta property="rendition:orientation">auto</meta>
		<meta property="rendition:spread">auto</meta>`;

		//Add right-to-left page progression direction if detected
		if (bookIsRTL) {
			opf += `
		<meta property="rendition:page-progression-direction">rtl</meta>`;
		}

		opf += `
	</metadata>
	<manifest>
		<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
		<item id="style" href="Styles/style.css" media-type="text/css"/>`;

		//Add all image pages to manifest
		imageFiles.forEach((img, index) => {
			const pageNum = index + 1;
			opf += `
		<item id="page${pageNum}" href="Text/page${String(pageNum).padStart(3, "0")}.xhtml" media-type="application/xhtml+xml"/>`;
		});

		//Add all images to manifest
		imageFiles.forEach((img, index) => {
			const pageNum = index + 1;
			//The code formatter is going wild here and it won't stop.
			const mediaType =
				img.extension === "png"
					? "image/png"
					: img.extension === "jpg" || img.extension === "jpeg"
						? "image/jpeg"
						: img.extension === "webp"
							? "image/webp"
							: img.extension === "gif"
								? "image/gif"
								: "image/png";
			opf += `
		<item id="img${pageNum}" href="Images/${img.filename}" media-type="${mediaType}"/>`;
		});

		opf += `
	</manifest>
	<spine toc="ncx">`;

		//Add all pages to spine (reading order) with spread properties
		const pagesWithSpread = imageFiles.filter((img) => img.spreadInfo && (img.spreadInfo.spread || img.spreadInfo.pageSpread)).length;
		if (pagesWithSpread > 0) {
			log.info(`EPUB: Applying spread metadata to ${pagesWithSpread} pages`);
		}

		imageFiles.forEach((img, index) => {
			const pageNum = index + 1;
			let itemrefAttrs = `idref="page${pageNum}"`;

			//Add spread properties if available
			if (img.spreadInfo) {
				const properties = [];

				// rendition:spread can be "auto", "both", "none", or "landscape"
				// - "auto": Let the reader decide based on viewport
				// - "both": This page should always be displayed as two-page spread
				// - "none": This page should always be displayed alone (like cover)
				// - "landscape": This is a landscape page that spans both pages
				if (img.spreadInfo.spread === "none") {
					// Cover or single page that should not be paired
					properties.push("rendition:spread-none");
				} else if (img.spreadInfo.spread === "both" || img.spreadInfo.spread === "landscape") {
					// Double page spread
					properties.push("rendition:spread-both");
				}
				// For "auto" or null, we don't add any spread property

				// rendition:page-spread-left or rendition:page-spread-right
				// Indicates which side this page should appear on in a two-page spread
				if (img.spreadInfo.pageSpread === "left") {
					properties.push("rendition:page-spread-left");
				} else if (img.spreadInfo.pageSpread === "right") {
					properties.push("rendition:page-spread-right");
				}

				// Add properties attribute if we have any properties
				if (properties.length > 0) {
					itemrefAttrs += ` properties="${properties.join(" ")}"`;
				}
			}

			opf += `
		<itemref ${itemrefAttrs}/>`;
		});

		opf += `
	</spine>
</package>`;

		return opf;
	}

	/**
	 * Generate toc.ncx for EPUB format.
	 * This is the navigation document for EPUB 2.0 compatibility.
	 *
	 * @param {Array} imageFiles Array of image file objects.
	 * @returns {string} The toc.ncx content.
	 */
	function generateTocNCX(imageFiles) {
		/**
		 * Escape XML special characters.
		 * @param {string} str The string to escape.
		 * @returns {string} The escaped string.
		 */
		function escapeXML(str) {
			if (!str) return "";
			return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
		}

		const title = escapeXML(bookMetadata.bookTitle || "Unknown Title");
		const identifier = bookMetadata.asin || `uuid-${Date.now()}`;

		let ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
	<head>
		<meta name="dtb:uid" content="${escapeXML(identifier)}"/>
		<meta name="dtb:depth" content="1"/>
		<meta name="dtb:totalPageCount" content="0"/>
		<meta name="dtb:maxPageNumber" content="0"/>
	</head>
	<docTitle>
		<text>${title}</text>
	</docTitle>
	<navMap>`;

		//For manga without chapter info, create a single entry pointing to first page
		if (!bookToc || bookToc.length === 0) {
			ncx += `
		<navPoint id="navpoint-1" playOrder="1">
			<navLabel>
				<text>Start</text>
			</navLabel>
			<content src="Text/page001.xhtml"/>
		</navPoint>`;
		} else {
			//Add chapter entries if TOC is available
			bookToc.forEach((chapter, index) => {
				const playOrder = index + 1;
				const chapterTitle = escapeXML(chapter.label || chapter.title || `Chapter ${playOrder}`);

				//Map chapter position to actual page number
				let pageNum = playOrder; //Fallback: use sequential numbering

				if (bookLocationMap && bookLocationMap.locations && chapter.tocPositionId !== undefined) {
					//Find the index in locationMap where the position matches the chapter's tocPositionId
					const positionIndex = bookLocationMap.locations.findIndex((pos) => pos === chapter.tocPositionId);
					if (positionIndex !== -1) {
						//Find the corresponding page in imageFiles
						//imageFiles is sorted by pageIndex, so we need to find which sequential page corresponds to this position
						const matchingImageIndex = imageFiles.findIndex((img) => img.pageIndex === positionIndex);
						if (matchingImageIndex !== -1) {
							pageNum = matchingImageIndex + 1; //1-based page number
						}
					}
				}

				const pageFile = `page${String(pageNum).padStart(3, "0")}.xhtml`;
				ncx += `
		<navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
			<navLabel>
				<text>${chapterTitle}</text>
			</navLabel>
			<content src="Text/${pageFile}"/>
		</navPoint>`;
			});
		}

		ncx += `
	</navMap>
</ncx>`;

		return ncx;
	}

	/**
	 * Generate an XHTML page for a single image in EPUB format.
	 *
	 * @param {number} pageNum The page number (1-indexed).
	 * @param {string} imageFilename The filename of the image.
	 * @returns {string} The XHTML content.
	 */
	function generatePageXHTML(pageNum, imageFilename) {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
	<title>Page ${pageNum}</title>
	<link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
	<div class="page">
		<img src="../Images/${imageFilename}" alt="Page ${pageNum}"/>
	</div>
</body>
</html>`;
	}

	/**
	 * Generate CSS stylesheet for EPUB format.
	 *
	 * @returns {string} The CSS content.
	 */
	function generateEPUBCSS() {
		return `
body {
	margin: 0;
	padding: 0;
	text-align: center;
	background-color: #000;
}

.page {
	margin: 0;
	padding: 0;
	height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
}

img {
	max-width: 100%;
	max-height: 100vh;
	width: auto;
	height: auto;
	display: block;
	margin: 0 auto;
}
`;
	}

	/**
	 * Generate EPUB format from a ZIP containing images.
	 * EPUB is a standardized e-book format with proper structure and metadata.
	 *
	 * @param {JSZip} sourceZip The source ZIP containing images.
	 * @returns {Promise<JSZip>} A new JSZip instance formatted as EPUB.
	 */
	async function generateEPUB(sourceZip) {
		try {
			log.info("Generating EPUB format...");
			progressModal.addStatus("📖 Converting to EPUB format...", "info");

			const epubZip = new JSZip();

			//Step 1: Extract and sort images from source ZIP
			const imageFiles = [];
			const fileNames = Object.keys(sourceZip.files);

			log.info(`EPUB: Found ${fileNames.length} files in source ZIP`);

			for (const fileName of fileNames) {
				const file = sourceZip.files[fileName];
				if (!file.dir) {
					//Extract pageIndex from filename (format: page_XXX_elementId.ext)
					const match = fileName.match(/page_(\d+)_.*\.(png|jpg|jpeg|webp|gif)$/i);
					if (match) {
						try {
							const pageIndex = parseInt(match[1], 10);
							const extension = match[2].toLowerCase();
							const data = await file.async("arraybuffer");

							imageFiles.push({
								pageIndex: pageIndex,
								extension: extension,
								data: data,
								originalName: fileName,
							});
							log.info(`EPUB: Extracted ${fileName}`);
						} catch (extractError) {
							log.error(`EPUB: Failed to extract ${fileName}:`, extractError);
							progressModal.addStatus(`⚠️ Failed to extract ${fileName}`, "warning");
						}
					}
				}
			}

			if (imageFiles.length === 0) {
				throw new Error("No valid image files found in source ZIP");
			}

			//Sort by pageIndex
			imageFiles.sort((a, b) => a.pageIndex - b.pageIndex);

			log.info(`EPUB: Processing ${imageFiles.length} images`);
			progressModal.addStatus(`📄 Processing ${imageFiles.length} images...`, "info");

			//Step 2: Add mimetype file (MUST be first, MUST be uncompressed)
			epubZip.file("mimetype", "application/epub+zip", { compression: "STORE" });
			log.okay("EPUB: Added mimetype");

			//Step 3: Add META-INF/container.xml
			epubZip.file("META-INF/container.xml", generateContainerXML());
			log.okay("EPUB: Added container.xml");

			//Step 4: Add images with sequential naming in OEBPS/Images/
			const processedImages = [];
			imageFiles.forEach((img, index) => {
				const sequentialNumber = index + 1;
				const newFileName = `page_${String(sequentialNumber).padStart(3, "0")}.${img.extension}`;
				epubZip.file(`OEBPS/Images/${newFileName}`, img.data);

				// Recalculate spread info based on SEQUENTIAL index in EPUB, not original sparse pageIndex
				// This ensures correct left/right assignment after deduplication
				const sequentialSpreadInfo = inferSpreadInfo(index);

				processedImages.push({
					filename: newFileName,
					extension: img.extension,
					pageIndex: img.pageIndex,
					spreadInfo: sequentialSpreadInfo,
				});
				log.info(`EPUB: Added image ${newFileName}`);
			});

			progressModal.addStatus(`✅ Added ${imageFiles.length} images`, "success");

			//Step 5: Generate XHTML pages for each image
			processedImages.forEach((img, index) => {
				const pageNum = index + 1;
				const xhtmlFile = `page${String(pageNum).padStart(3, "0")}.xhtml`;
				const xhtml = generatePageXHTML(pageNum, img.filename);
				epubZip.file(`OEBPS/Text/${xhtmlFile}`, xhtml);
			});

			progressModal.addStatus(`✅ Generated ${processedImages.length} XHTML pages`, "success");
			log.okay(`EPUB: Generated ${processedImages.length} XHTML pages`);

			//Step 6: Add CSS stylesheet
			epubZip.file("OEBPS/Styles/style.css", generateEPUBCSS());
			log.okay("EPUB: Added stylesheet");

			//Step 7: Generate and add content.opf
			const contentOPF = generateContentOPF(processedImages);
			epubZip.file("OEBPS/content.opf", contentOPF);
			log.okay("EPUB: Added content.opf");

			//Step 8: Generate and add toc.ncx
			const tocNCX = generateTocNCX(processedImages);
			epubZip.file("OEBPS/toc.ncx", tocNCX);
			log.okay("EPUB: Added toc.ncx");

			progressModal.addStatus("✅ EPUB structure complete", "success");
			log.okay("EPUB: Format ready");

			return epubZip;
		} catch (error) {
			log.error("EPUB: Generation failed:", error);
			progressModal.addStatus(`❌ EPUB generation failed: ${error.message}`, "error");
			throw error;
		}
	}

	/**
	 * Infer spread information for a page based on its position and reading direction.
	 * Manga typically displays:
	 * - Cover page alone (spread-none)
	 * - Interior pages in pairs (odd/even)
	 * - RTL: right page first (odd), left page second (even)
	 * - LTR: left page first (odd), right page second (even)
	 *
	 * @param {number} pageIndex The index of the page (0-based).
	 * @returns {Object} Spread info with spread and pageSpread properties.
	 */
	function inferSpreadInfo(pageIndex) {
		//Cover page should not be in a spread
		if (pageIndex === bookCoverPosition) {
			return {
				spread: "none",
				pageSpread: null,
			};
		}

		//For manga pages after the cover:
		//In RTL: odd-indexed pages are RIGHT, even-indexed pages are LEFT
		//In LTR: odd-indexed pages are LEFT, even-indexed pages are RIGHT
		let pageSpread;
		if (bookIsRTL) {
			//RTL manga: page 1 is right, page 2 is left, page 3 is right, etc.
			pageSpread = pageIndex % 2 === 1 ? "right" : "left";
		} else {
			//LTR: page 1 is left, page 2 is right, page 3 is left, etc.
			pageSpread = pageIndex % 2 === 1 ? "left" : "right";
		}

		return {
			spread: "auto", //Let reader decide, but provide page-spread hints
			pageSpread: pageSpread,
		};
	}

	/**
	 * Download images from the CDN based on the manifest and page data.
	 * This function extracts image references from the page data, maps them to CDN URLs using the manifest,
	 * and downloads each image while updating the progress modal.
	 *
	 * @param {Object} manifest The manifest containing CDN resources and authentication info.
	 * @param {Array} pageData The array of page data objects.
	 * @param {Object} karamelToken The Karamel token for authentication.
	 * @param {string} format The output format ('zip', 'cbz', or 'epub').
	 * @returns {Promise<void>}
	 */
	async function downloadImages(manifest, pageData, karamelToken, format = "zip") {
		if (!manifest || !manifest.cdnResources || !manifest.cdn) {
			log.error("Invalid manifest data");
			return;
		}

		const { baseUrl, authParameter } = manifest.cdn;
		const resourceMap = {};

		//Create a map of resource references to URLs
		manifest.cdnResources.forEach((resource) => {
			const resourceId = resource.url.split("/")[1];
			resourceMap[resource.url] = {
				url: `${baseUrl}/${resource.url}`,
				type: resource.type,
			};
		});

		log.info("Resource Map:", resourceMap);

		//Use script-scoped RTL and cover position values set in downloadBook
		log.info(`Reading direction: ${bookIsRTL ? "RTL" : "LTR"}, Cover position: ${bookCoverPosition}`);

		//Extract image references and infer spread metadata from page data
		//Use a Map to deduplicate images by elementId (same image may appear on multiple pages)
		const imageMap = new Map();
		pageData.forEach((page) => {
			if (page.children) {
				page.children.forEach((child) => {
					if (child.imageReference && child.elementId) {
						//Skip if we've already seen this image
						if (imageMap.has(child.elementId)) {
							return;
						}

						const resource = resourceMap[child.imageReference];
						if (resource) {
							//Build full URL with auth parameters from manifest AND karamel token
							let imageUrl = `${resource.url}?${authParameter}`;

							//Add token and expiration from karamelToken
							if (karamelToken && karamelToken.token) {
								imageUrl += `&token=${encodeURIComponent(karamelToken.token)}`;
							}
							if (karamelToken && karamelToken.expiresAt) {
								imageUrl += `&expiration=${karamelToken.expiresAt}`;
							}

							//Infer page spread metadata for EPUB generation
							//Since Kindle API doesn't provide explicit spread properties,
							//we infer them based on page position and reading direction
							const spreadInfo = inferSpreadInfo(page.pageIndex);

							//Store unique image by elementId
							imageMap.set(child.elementId, {
								pageIndex: page.pageIndex,
								url: imageUrl,
								elementId: child.elementId,
								resourceType: resource.type,
								spreadInfo: spreadInfo,
							});
						}
					}
				});
			}
		});

		//Convert Map to array and sort by pageIndex to maintain correct order
		const imageUrls = Array.from(imageMap.values()).sort((a, b) => a.pageIndex - b.pageIndex);

		//Log deduplication info
		log.info(`Found ${imageUrls.length} unique images to download`);

		//Log spread info for debugging (only for first few pages)
		imageUrls.slice(0, 5).forEach((img) => {
			log.info(`Page ${img.pageIndex} (element ${img.elementId}) spread info:`, img.spreadInfo);
		});

		progressModal.addStatus(`🖼️  Found ${imageUrls.length} images to download`, "info");
		log.info(`Found ${imageUrls.length} images to download`);

		//Create a mapping of pageIndex to spread metadata for EPUB generation
		const pageSpreadMetadata = {};
		imageUrls.forEach((imgUrl) => {
			if (imgUrl.spreadInfo && (imgUrl.spreadInfo.spread || imgUrl.spreadInfo.pageSpread)) {
				pageSpreadMetadata[imgUrl.pageIndex] = imgUrl.spreadInfo;
			}
		});

		if (Object.keys(pageSpreadMetadata).length > 0) {
			log.info(`Found spread metadata for ${Object.keys(pageSpreadMetadata).length} pages`);
		}

		const zip = new JSZip();
		const bookTitle = bookMetadata?.bookTitle || "manga";

		const maxImages = DEBUG_MODE ? Math.min(DEBUG_MAX_IMAGES, imageUrls.length) : imageUrls.length;
		if (DEBUG_MODE) {
			progressModal.addStatus(`🐛 DEBUG MODE: Only downloading first ${maxImages} images`, "warning");
			log.warning(`DEBUG MODE: Downloading only first ${maxImages} of ${imageUrls.length} images`);
		}

		//Download each image
		for (let i = 0; i < maxImages; i++) {
			const { pageIndex, url, elementId, resourceType, spreadInfo } = imageUrls[i];

			try {
				const imgResponse = await fetch(url, {
					mode: "cors",
					cache: "no-cache",
				});

				if (!imgResponse.ok) {
					progressModal.addStatus(`[ERROR] Image ${i + 1} failed: ${imgResponse.status}`, "error");
					log.error(`Failed to download image ${i + 1}: ${imgResponse.status}`);
					continue;
				}

				const blob = await imgResponse.blob();
				const arrayBuffer = await blob.arrayBuffer();

				//Debug logging for first image only
				if (i === 0) {
					log.info(`DEBUG: Image ${i + 1}`);
					log.info(`Resource type: ${resourceType || "unknown"}`);
					logBytes(arrayBuffer, "Encrypted data (first 16 bytes)");
				}

				let finalData;
				let imageFormat = "png";
				try {
					finalData = await decryptImage(arrayBuffer, karamelToken);

					if (i === 0) {
						logBytes(finalData, "Decrypted data (first 16 bytes)");
					}

					imageFormat = detectImageFormat(finalData);

					if (i === 0) {
						log.info(`Detected format: ${imageFormat}`);
						log.info(`END DEBUG`);
					}

					if (imageFormat === "unknown") {
						progressModal.addStatus(`❌ Image ${i + 1} unknown format`, "error");
						log.error(`Image ${i + 1} decryption produced unknown format`);
						logBytes(finalData, `  Unknown format bytes (image ${i + 1})`);
						continue;
					}
				} catch (decryptError) {
					progressModal.addStatus(`❌ Decryption failed for image ${i + 1}`, "error");
					log.error(`Failed to decrypt image ${i + 1}:`, decryptError);
					continue;
				}

				const filename = `page_${String(pageIndex).padStart(3, "0")}_${elementId}.${imageFormat}`;
				zip.file(filename, finalData);

				//Update progress
				progressModal.updateProgress("🖼️  Downloading Images", i + 1, maxImages, (i + 1) % 10 === 0 ? `✅ ${filename} (${(finalData.byteLength / 1024).toFixed(1)} KB)` : null);

				log.okay(`Downloaded: ${filename}`);
			} catch (error) {
				progressModal.addStatus(`❌ Error on image ${i + 1}`, "error");
				log.error(`Error downloading image ${i + 1}:`, error);
			}
		}

		//Generate and download ZIP/CBZ
		let finalZip = zip;

		const fileCount = Object.keys(finalZip.files).length;
		let archiveType = format === "cbz" ? "CBZ" : format === "epub" ? "EPUB" : "ZIP";

		//If CBZ format is selected prepare the data for CBZ formatting with ComicInfo.xml.
		if (format === "cbz") {
			try {
				log.info("Starting CBZ conversion...");
				finalZip = await generateCBZ(finalZip);
				log.okay("CBZ conversion completed successfully");
			} catch (cbzError) {
				log.error("CBZ conversion failed, falling back to ZIP:", cbzError);
				progressModal.addStatus(`⚠️ CBZ conversion failed, using ZIP format instead`, "warning");
			}
		} else if (format === "epub") {
			try {
				log.info("Starting EPUB conversion...");
				finalZip = await generateEPUB(finalZip);
				log.okay("EPUB conversion completed successfully");
				archiveType = "ZIP";
			} catch (epubError) {
				log.error("EPUB conversion failed, falling back to ZIP:", epubError);
				progressModal.addStatus(`⚠️ EPUB conversion failed, using ZIP format instead`, "warning");
				archiveType = "ZIP";
			}
		}

		progressModal.addStatus(`📦 Creating ${archiveType} with ${fileCount} files...`, "info");
		log.info(`Creating ${archiveType} file with ${fileCount} files...`);

		try {
			const zipBlob = await finalZip.generateAsync(
				{
					type: "blob",
					compression: "STORE",
				},
				(zipMetadata) => {
					const percent = zipMetadata.percent.toFixed(1);
					if (zipMetadata.percent % 10 < 1) {
						progressModal.updateProgress("📦 Creating Archive", Math.round(zipMetadata.percent), 100, `Processing: ${zipMetadata.currentFile || "finalizing"}`);
					}
					log.info(`ZIP progress: ${percent}% - ${zipMetadata.currentFile || "processing"}`);
				},
			);

			progressModal.addStatus(`✅ ${archiveType} created: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`, "success");
			log.okay(`${archiveType} file created: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);

			//Determine file extension and format name
			const fileExtension = format === "epub" ? "epub" : format === "cbz" ? "cbz" : "zip";
			const formatName = format === "epub" ? "EPUB" : format === "cbz" ? "CBZ" : "ZIP";

			const zipUrl = URL.createObjectURL(zipBlob);
			const a = document.createElement("a");
			a.href = zipUrl;
			a.download = `${sanitizeFilename(bookTitle)}.${fileExtension}`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(zipUrl);

			progressModal.addStatus(`🎉 Download complete!`, "success");
			log.okay("Download complete!");

			setTimeout(() => {
				progressModal.close();
				showModal("✅ Download Complete", `Successfully downloaded ${fileCount} images!\nFormat: ${formatName}\nFile: ${sanitizeFilename(bookTitle)}.${fileExtension}`, [
					{ text: "OK", type: "primary" },
				]);
			}, 2000);
		} catch (zipError) {
			progressModal.addStatus(`❌ ZIP generation failed`, "error");
			log.error("ZIP generation failed:", zipError);
			progressModal.close();
			showModal("❌ ZIP Generation Failed", `Error: ${zipError.message}`, [{ text: "OK", type: "primary" }]);
			throw zipError;
		}
	}

	/**
	 * Decrypt encrypted image using AES-GCM.
	 *
	 * @param {ArrayBuffer} encryptedArrayBuffer - The encrypted image data.
	 * @param {Object} karamelToken - The Karamel token containing the key and expiration.
	 * @returns {Promise<ArrayBuffer>} The decrypted image data.
	 * @throws Will throw an error if decryption fails or if the token is invalid.
	 */
	async function decryptImage(encryptedArrayBuffer, karamelToken) {
		try {
			//Step 1: Extract 40-character key from token
			//Key location = token.substring(expiresAt % 60, (expiresAt % 60) + 40)
			if (!karamelToken || !karamelToken.token || !karamelToken.expiresAt) {
				throw new Error("Invalid karamel token for decryption");
			}

			if (karamelToken.token.length < 100) {
				throw new Error("Token too short for key extraction");
			}

			const offset = karamelToken.expiresAt % 60;
			const keyString = karamelToken.token.substring(offset, offset + 40);

			//Step 2: Parse encrypted data structure
			//Format: [salt(24 base64)][IV(24 base64)][encrypted data(rest, base64)]
			const decoder = new TextDecoder("utf-8");
			const encodedText = decoder.decode(encryptedArrayBuffer);

			const saltB64 = encodedText.substring(0, 24);
			const ivB64 = encodedText.substring(24, 48);
			const encryptedDataB64 = encodedText.substring(48);

			//Step 3: Decode base64 components
			const salt = base64ToArrayBuffer(saltB64);
			const iv = base64ToArrayBuffer(ivB64);
			const encryptedData = base64ToArrayBuffer(encryptedDataB64);

			//Step 4: Import raw key for PBKDF2
			const encoder = new TextEncoder();
			const rawKey = await window.crypto.subtle.importKey("raw", encoder.encode(keyString), { name: "PBKDF2" }, false, ["deriveKey"]);

			//Step 5: Derive AES-GCM key using PBKDF2
			const aesKey = await window.crypto.subtle.deriveKey(
				{
					name: "PBKDF2",
					salt: salt,
					iterations: 1000,
					hash: "SHA-256",
				},
				rawKey,
				{ name: "AES-GCM", length: 128 },
				false,
				["decrypt"],
			);

			//Step 6: Decrypt using AES-GCM
			const decryptedData = await window.crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: iv,
					additionalData: encoder.encode(keyString.slice(0, 9)), //First 9 chars as AAD
					tagLength: 128,
				},
				aesKey,
				encryptedData,
			);

			return decryptedData;
		} catch (error) {
			log.error("Decryption failed:", error);
			throw error;
		}
	}

	/**
	 * Convert a base64 string to an ArrayBuffer.
	 *
	 * @param {string} base64 - The base64 string to convert.
	 * @returns {ArrayBuffer} The resulting ArrayBuffer.
	 */
	function base64ToArrayBuffer(base64) {
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes.buffer;
	}

	/**
	 * Detect the image format based on the magic numbers in the ArrayBuffer.
	 *
	 * @param {ArrayBuffer} arrayBuffer - The ArrayBuffer containing the image data.
	 * @returns {string} The detected image format ("png", "jpeg", "webp", "gif", or "unknown").
	 */
	function detectImageFormat(arrayBuffer) {
		const bytes = new Uint8Array(arrayBuffer);

		if (bytes.length < 8) {
			return "unknown";
		}

		//PNG: 89 50 4E 47 0D 0A 1A 0A
		const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		let isPNG = true;
		for (let i = 0; i < pngSignature.length; i++) {
			if (bytes[i] !== pngSignature[i]) {
				isPNG = false;
				break;
			}
		}
		if (isPNG) {
			return "png";
		}

		//JPEG: FF D8 FF
		if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
			return "jpeg";
		}

		//WebP: RIFF ... WEBP
		if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
			if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
				return "webp";
			}
		}

		//GIF: GIF87a or GIF89a
		if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
			return "gif";
		}

		return "unknown";
	}

	/**
	 * Log the first N bytes of an ArrayBuffer for debugging purposes.
	 *
	 * @param {ArrayBuffer} arrayBuffer - The ArrayBuffer to log.
	 * @param {string} label - A label to identify the log output.
	 * @param {number} [count=16] - The number of bytes to log.
	 */
	function logBytes(arrayBuffer, label, count = 16) {
		const bytes = new Uint8Array(arrayBuffer);
		const hex = Array.from(bytes.slice(0, count))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(" ");
		log.info(`${label}: ${hex} (${bytes.length} bytes total)`);
	}

	/**
	 * Get the cached bookInfo or parse it from the script tag if not cached.
	 *
	 * @returns {Object|null} The bookInfo object or null if not found.
	 */
	function getBookInfo() {
		if (cachedBookInfo) {
			return cachedBookInfo;
		}

		//Find the bookInfo script tag
		const bookInfoScript = document.getElementById("bookInfo");
		if (bookInfoScript) {
			try {
				cachedBookInfo = JSON.parse(bookInfoScript.textContent);
				log.info("Book Info loaded:", cachedBookInfo);
				return cachedBookInfo;
			} catch (error) {
				log.error("Failed to parse bookInfo:", error);
			}
		}

		return null;
	}

	/**
	 * Extract ASIN from current page.
	 *
	 * @returns {string|null} The ASIN if found, otherwise null.
	 */
	function extractAsinFromPage() {
		//Try bookInfo first
		const bookInfo = getBookInfo();
		if (bookInfo && bookInfo.asin) {
			return bookInfo.asin;
		}

		//Try URL (e.g., https://read.amazon.co.jp/manga/B0BC152FG1)
		const urlMatch = window.location.href.match(/\/([A-Z0-9]{10})(?:\/|$)/);
		if (urlMatch) {
			return urlMatch[1];
		}

		//Try meta tag
		const metaAsin = document.querySelector('meta[name="asin"]');
		if (metaAsin) {
			return metaAsin.content;
		}

		//Try data attribute
		const asinElement = document.querySelector("[data-asin]");
		if (asinElement) {
			return asinElement.getAttribute("data-asin");
		}

		return null;
	}

	/**
	 * Extract rendering token from page
	 * The rendering token is required for all requests to the render endpoint and is stored in the bookInfo.karamelToken.token field.
	 * The token also has an expiration time (bookInfo.karamelToken.expiresAt) and must be checked for validity before use.
	 *
	 * @returns {string|null} The rendering token if found and valid, otherwise null.
	 */
	function extractRenderingToken() {
		//Get token from bookInfo script tag
		const bookInfo = getBookInfo();
		if (bookInfo && bookInfo.karamelToken && bookInfo.karamelToken.token) {
			const token = bookInfo.karamelToken.token;
			const expiresAt = bookInfo.karamelToken.expiresAt;

			//Check if token is still valid
			if (expiresAt && Date.now() > expiresAt) {
				log.warning("Rendering token has expired!");
				alert("The rendering token has expired. Please reload the page.");
				return null;
			}

			log.okay("Rendering token extracted successfully");
			log.info("Token expires at:", new Date(expiresAt).toLocaleString());
			return token;
		}

		log.error("Could not find rendering token in bookInfo");
		return null;
	}

	/**
	 * Extract revision ID from page.
	 * The revision ID is a unique identifier for the specific version of the book and is required for all requests to the render endpoint. It is stored in the bookInfo.contentGuid field.
	 *
	 * @returns {string|null} The revision ID if found, otherwise null.
	 */
	function extractRevision() {
		//Get revision from bookInfo (stored as contentGuid)
		const bookInfo = getBookInfo();
		if (bookInfo && bookInfo.contentGuid) {
			log.okay("Revision extracted:", bookInfo.contentGuid);
			return bookInfo.contentGuid;
		}

		log.error("Could not find revision (contentGuid) in bookInfo");
		return null;
	}

	/**
	 * Sanitize a filename by replacing invalid characters with underscores and truncating to 200 characters.
	 * This ensures the filename is safe for most file systems and prevents issues with excessively long names.
	 *
	 * @param {string} filename The filename to sanitize.
	 * @returns {string} The sanitized filename.
	 */
	function sanitizeFilename(filename) {
		return filename.replace(/[<>:"/\\|?*]/g, "_").substring(0, 200);
	}

	/**
	 * Initialize the script by adding the download button when the DOM is fully loaded.
	 */
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", addDownloadButton);
	} else {
		addDownloadButton();
	}
})();
