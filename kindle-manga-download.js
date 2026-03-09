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

	console.log("Kindle Manga Downloader loaded");
	if (DEBUG_MODE) {
		console.log(`🐛 DEBUG MODE ENABLED: Max ${DEBUG_MAX_PAGE_REQUESTS} page requests, Max ${DEBUG_MAX_IMAGES} images`);
	}

	let currentModal = null;
	let cachedBookInfo = null;

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
				white-space: pre-wrap;
				overflow-y: auto;
				flex-grow: 1;
			}
			
			.kindle-modal-buttons {
				display: flex;
				gap: 12px;
				justify-content: flex-end;
				flex-shrink: 0;
			}
			
			.kindle-modal-button {
				padding: 10px 20px;
				border: none;
				border-radius: 5px;
				cursor: pointer;
				font-size: 14px;
				font-weight: 600;
				transition: all 0.2s;
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
		`;
		document.head.appendChild(style);
	}

	/**
	 * Show a modal with a title, content, and optional buttons.
	 *
	 * @param {string} title The title of the modal.
	 * @param {string|HTMLElement} content The content of the modal.
	 * @param {Array} buttons An array of button objects with text, type, and onClick properties.
	 * @returns {HTMLElement} The overlay element of the modal.
	 */
	function showModal(title, content, buttons = []) {
		injectModalStyles();
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
	 * Create a progress modal with a title.
	 *
	 * @param {string} title The title of the progress modal.
	 * @returns {Object} An object containing the overlay element, content element, and methods to update progress and add status messages.
	 */
	function createProgressModal(title) {
		injectModalStyles();
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
				fill.style.width = `${percent}%`;
				text.textContent = `${percent}% (${current}/${total})`;

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

	/*
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

	/**
	 * Add a "Download Book" button to the page in the top right.
	 */
	function addDownloadButton() {
		const button = document.createElement("button");
		button.textContent = "Download Book";
		button.style.cssText = `
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
		`;
		button.addEventListener("click", downloadBook);
		document.body.appendChild(button);

		//Also add a status check button for debugging
		const statusButton = document.createElement("button");
		statusButton.textContent = "🔍 Check Status";
		statusButton.style.cssText = `
			position: fixed;
			top: 10px;
			right: 210px;
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
		`;
		statusButton.addEventListener("click", checkStatus);
		document.body.appendChild(statusButton);
	}

	/**
	 * Check the status of all required data for downloading the book and display a comprehensive report in a modal.
	 */
	function checkStatus() {
		console.log("=== Kindle Downloader Status Check ===");

		const bookInfo = getBookInfo();
		const asin = extractAsinFromPage();
		const revision = extractRevision();
		const token = extractRenderingToken();

		let status = "";

		if (bookInfo) {
			status += `[OKAY] Book Info: Found\n`;
			status += `   Title: ${bookInfo.title || "N/A"}\n`;
			status += `   ASIN: ${bookInfo.asin || "N/A"}\n`;
			status += `   Revision: ${bookInfo.contentGuid || "N/A"}\n`;
			status += `   Content Type: ${bookInfo.bookContentType || "N/A"}\n`;
			if (bookInfo.karamelToken) {
				const expiresAt = new Date(bookInfo.karamelToken.expiresAt);
				const isExpired = Date.now() > bookInfo.karamelToken.expiresAt;
				status += `   Token: ${isExpired ? "[WARNING] EXPIRED" : "[OKAY] Valid"}\n`;
				status += `   Expires: ${expiresAt.toLocaleString()}\n`;
			}
		} else {
			status += `[ERROR] Book Info: Not Found\n`;
		}

		status += `\n${asin ? "[OKAY] " : "[ERROR] "} ASIN: ${asin || "Not found"}\n`;
		status += `${revision ? "[OKAY] " : "[ERROR] "} Revision: ${revision || "Not found"}\n`;
		status += `${token ? "[OKAY] " : "[ERROR] "} Rendering Token: ${token ? "Found (" + token.substring(0, 20) + "...)" : "Not found"}\n`;

		const allReady = bookInfo && asin && revision && token;
		status += `\n${allReady ? "🎉 Ready to download!" : "[WARNING] Missing required data"}`;

		showModal("📊 Status Report", status, [{ text: "Close", type: "primary" }]);
		console.log(status);

		if (bookInfo) {
			console.log("Full Book Info:", bookInfo);
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
				console.log(`Parsed: ${file.name}`);
			}

			return fileMap;
		} catch (error) {
			console.error("Error parsing TAR:", error);
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

		const renderUrl = `https://read.amazon.co.jp/renderer/render?${params.toString()}`;
		console.log(`📥 Fetching position ${startingPosition}...`);

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
		let progressModal = null;
		try {
			console.log("🚀 Starting book download...");

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
			console.log("📖 Step 1: Fetching Table of Contents...");
			progressModal = createProgressModal("📥 Downloading Manga");
			progressModal.addStatus("📖 Fetching Table of Contents...", "info");

			const tocBuffer = await fetchPages(asin, revision, renderingToken, 0, 2, true);
			const tocFiles = await parseTarResponse(tocBuffer);

			const toc = tocFiles["toc.json"];
			const metadata = tocFiles["metadata.json"];
			const locationMap = tocFiles["location_map.json"];
			const initialManifest = tocFiles["manifest.json"];

			progressModal.addStatus("[OKAY] Table of Contents loaded", "success");
			console.log("📚 Book Info:");
			console.log("  Title:", metadata.bookTitle);
			console.log("  Authors:", metadata.authors);
			console.log("  First Position:", metadata.firstPositionId);
			console.log("  Last Position:", metadata.lastPositionId);
			console.log("  Total Locations:", locationMap.locations.length);
			toc.forEach((chapter) => {
				console.log(`    - ${chapter.label} (position ${chapter.tocPositionId})`);
			});

			//Step 2: Calculate how many requests we need
			const totalLocations = locationMap.locations.length;
			const pagesPerRequest = 2;
			const estimatedRequests = Math.ceil(totalLocations / pagesPerRequest);

			console.log(`\n📊 Download Plan:`);
			console.log(`  Total locations: ${totalLocations}`);
			console.log(`  Pages per request: ${pagesPerRequest}`);
			console.log(`  Estimated requests: ${estimatedRequests}`);

			progressModal.close();
			const confirmDownload = await showConfirm(
				"📖 Ready to Download",
				`Title: ${metadata.bookTitle}\n` +
					`Total locations: ${totalLocations}\n` +
					`Estimated requests: ${estimatedRequests}\n` +
					`Chapters: ${toc.length}\n\n` +
					`This may take a few minutes. Continue?`,
			);

			if (!confirmDownload) {
				console.log("Download cancelled by user");
				return;
			}

			progressModal = createProgressModal("📥 Downloading Manga");

			//Step 3: Download all pages
			console.log("\n📥 Step 2: Downloading all pages...");
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
				progressModal.updateProgress("📄 Downloading Pages", 1, estimatedRequests, "✓ Pages 0-1 downloaded");
				console.log(`✓ Downloaded pages 0-1 (from TOC request) - ${allPageData.length} pages total`);
			}

			console.log(`Starting loop from position index 2 to ${totalLocations}, stepping by ${pagesPerRequest}...`);

			//Download remaining pages using location map positions
			let requestCount = 1;
			const maxRequests = DEBUG_MODE ? DEBUG_MAX_PAGE_REQUESTS : totalLocations;

			for (let posIndex = 2; posIndex < totalLocations; posIndex += pagesPerRequest) {
				if (DEBUG_MODE && requestCount >= maxRequests) {
					progressModal.addStatus(`🐛 DEBUG MODE: Stopping after ${requestCount} requests`, "warning");
					console.log(`🐛 DEBUG MODE: Stopping after ${requestCount} requests`);
					break;
				}
				requestCount++;
				const startPos = locationMap.locations[posIndex];

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
							`✓ Pages ${posIndex}-${Math.min(posIndex + pagesPerRequest - 1, totalLocations - 1)} (+${pagesAdded})`,
						);
						console.log(
							`✓ Downloaded pages ${posIndex}-${Math.min(posIndex + pagesPerRequest - 1, totalLocations - 1)} (added ${pagesAdded} pages, ${allPageData.length} total pages so far)`,
						);
					} else {
						progressModal.addStatus(`⚠️ No page_data at position ${startPos}`, "warning");
						console.warn(`  No page_data file found for position ${startPos}`);
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
					progressModal.addStatus(`[ERROR] Failed at position ${startPos}`, "error");
					console.error(`[ERROR] Failed to download pages at position ${startPos}:`, error);
				}
			}

			progressModal.addStatus(`[OKAY] Downloaded ${allPageData.length} total pages`, "success");
			console.log(`\n[OKAY] Loop complete. Downloaded all page data: ${allPageData.length} pages total`);
			console.log(`Collected ${allCdnResources.size} unique CDN resources`);

			//Step 4: Download images from CDN
			console.log("\n🖼️ Step 3: Downloading images from CDN...");
			const bookInfo = getBookInfo();

			const mergedManifest = {
				...latestManifest,
				cdnResources: Array.from(allCdnResources.values()),
			};

			await downloadImages(mergedManifest, allPageData, metadata, bookInfo.karamelToken, progressModal);
		} catch (error) {
			if (progressModal) progressModal.close();
			console.error("Download failed:", error);
			showModal("[ERROR] Download Failed", `Error: ${error.message}`, [{ text: "OK", type: "primary" }]);
		}
	}

	/**
	 * Download images from the CDN based on the manifest and page data.
	 * This function extracts image references from the page data, maps them to CDN URLs using the manifest,
	 * and downloads each image while updating the progress modal.
	 *
	 * @param {Object} manifest The manifest containing CDN resources and authentication info.
	 * @param {Array} pageData The array of page data objects.
	 * @param {Object} metadata The metadata of the book.
	 * @param {Object} karamelToken The Karamel token for authentication.
	 * @param {Object} progressModal The progress modal for updating download status.
	 * @returns {Promise<void>}
	 */
	async function downloadImages(manifest, pageData, metadata, karamelToken, progressModal) {
		if (!manifest || !manifest.cdnResources || !manifest.cdn) {
			console.error("Invalid manifest data");
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

		console.log("Resource Map:", resourceMap);

		//Extract image references from page data
		const imageUrls = [];
		pageData.forEach((page) => {
			if (page.children) {
				page.children.forEach((child) => {
					if (child.imageReference) {
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

							imageUrls.push({
								pageIndex: page.pageIndex,
								url: imageUrl,
								elementId: child.elementId,
								resourceType: resource.type,
							});
						}
					}
				});
			}
		});

		progressModal.addStatus(`🖼️  Found ${imageUrls.length} images to download`, "info");
		console.log(`Found ${imageUrls.length} images to download`);

		const zip = new JSZip();
		const bookTitle = metadata?.bookTitle || "manga";

		const maxImages = DEBUG_MODE ? Math.min(DEBUG_MAX_IMAGES, imageUrls.length) : imageUrls.length;
		if (DEBUG_MODE) {
			progressModal.addStatus(`🐛 DEBUG MODE: Only downloading first ${maxImages} images`, "warning");
			console.log(`🐛 DEBUG MODE: Downloading only first ${maxImages} of ${imageUrls.length} images`);
		}

		//Download each image
		for (let i = 0; i < maxImages; i++) {
			const { pageIndex, url, elementId, resourceType } = imageUrls[i];

			try {
				const imgResponse = await fetch(url, {
					mode: "cors",
					cache: "no-cache",
				});

				if (!imgResponse.ok) {
					progressModal.addStatus(`[ERROR] Image ${i + 1} failed: ${imgResponse.status}`, "error");
					console.error(`Failed to download image ${i + 1}: ${imgResponse.status}`);
					continue;
				}

				const blob = await imgResponse.blob();
				const arrayBuffer = await blob.arrayBuffer();

				//Debug logging for first image only
				if (i === 0) {
					console.log(`\n=== DEBUG: Image ${i + 1} ===`);
					console.log(`Resource type: ${resourceType || "unknown"}`);
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
						console.log(`Detected format: ${imageFormat}`);
						console.log(`=== END DEBUG ===\n`);
					}

					if (imageFormat === "unknown") {
						progressModal.addStatus(`[ERROR] Image ${i + 1} unknown format`, "error");
						console.error(`[ERROR] Image ${i + 1} decryption produced unknown format`);
						logBytes(finalData, `  Unknown format bytes (image ${i + 1})`);
						continue;
					}
				} catch (decryptError) {
					progressModal.addStatus(`[ERROR] Decryption failed for image ${i + 1}`, "error");
					console.error(`[ERROR] Failed to decrypt image ${i + 1}:`, decryptError);
					continue;
				}

				const filename = `page_${String(pageIndex).padStart(3, "0")}_${elementId}.${imageFormat}`;
				zip.file(filename, finalData);

				//Update progress
				progressModal.updateProgress("🖼️  Downloading Images", i + 1, maxImages, (i + 1) % 10 === 0 ? `✓ ${filename} (${(finalData.byteLength / 1024).toFixed(1)} KB)` : null);

				console.log(`✓ Downloaded: ${filename}`);
			} catch (error) {
				progressModal.addStatus(`[ERROR] Error on image ${i + 1}`, "error");
				console.error(`Error downloading image ${i + 1}:`, error);
			}
		}

		//Generate and download ZIP
		const fileCount = Object.keys(zip.files).length;
		progressModal.addStatus(`📦 Creating ZIP with ${fileCount} files...`, "info");
		console.log(`📦 Creating ZIP file with ${fileCount} files...`);

		try {
			const zipBlob = await zip.generateAsync(
				{
					type: "blob",
					compression: "STORE",
				},
				(zipMetadata) => {
					const percent = zipMetadata.percent.toFixed(1);
					if (zipMetadata.percent % 10 < 1) {
						progressModal.updateProgress("📦 Creating Archive", Math.round(zipMetadata.percent), 100, `Processing: ${zipMetadata.currentFile || "finalizing"}`);
					}
					console.log(`📦 ZIP progress: ${percent}% - ${zipMetadata.currentFile || "processing"}`);
				},
			);

			progressModal.addStatus(`[OKAY] ZIP created: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`, "success");
			console.log(`[OKAY] ZIP file created: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);

			const zipUrl = URL.createObjectURL(zipBlob);
			const a = document.createElement("a");
			a.href = zipUrl;
			a.download = `${sanitizeFilename(bookTitle)}.zip`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(zipUrl);

			progressModal.addStatus(`🎉 Download complete!`, "success");
			console.log("[OKAY] Download complete!");

			setTimeout(() => {
				progressModal.close();
				showModal("[OKAY] Download Complete", `Successfully downloaded ${fileCount} images!\nFile: ${sanitizeFilename(bookTitle)}.zip`, [{ text: "OK", type: "primary" }]);
			}, 2000);
		} catch (zipError) {
			progressModal.addStatus(`[ERROR] ZIP generation failed`, "error");
			console.error("[ERROR] ZIP generation failed:", zipError);
			progressModal.close();
			showModal("[ERROR] ZIP Generation Failed", `Error: ${zipError.message}`, [{ text: "OK", type: "primary" }]);
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
			console.error("Decryption failed:", error);
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
		console.log(`${label}: ${hex} (${bytes.length} bytes total)`);
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
				console.log("[INFO] Book Info loaded:", cachedBookInfo);
				return cachedBookInfo;
			} catch (error) {
				console.error("Failed to parse bookInfo:", error);
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
				console.warn("[WARNING] Rendering token has expired!");
				alert("The rendering token has expired. Please reload the page.");
				return null;
			}

			console.log("[OKAY] Rendering token extracted successfully");
			console.log("Token expires at:", new Date(expiresAt).toLocaleString());
			return token;
		}

		console.error("[ERROR] Could not find rendering token in bookInfo");
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
			console.log("[OKAY] Revision extracted:", bookInfo.contentGuid);
			return bookInfo.contentGuid;
		}

		console.error("[ERROR] Could not find revision (contentGuid) in bookInfo");
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
