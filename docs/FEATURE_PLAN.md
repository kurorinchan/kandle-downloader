# Feature Plan: CBZ/CBR/EPUB Format Support

## Overview
Enhance the Kindle Manga Downloader to support multiple output formats (CBZ, CBR, EPUB) instead of just ZIP archives.  All necessary book and chapter metadata is already available from the download process.

## Available Metadata
From the current code, we have access to:
- **metadata.json**: `bookTitle`, `authors`, `firstPositionId`, `lastPositionId`
- **toc.json**: Array of chapters with `label` and `tocPositionId`
- **locationMap.json**: All page locations in the book
- **pageData**: Individual page information with `pageIndex` and `elementId`
- **Images**: Downloaded and decrypted image files with detected format

## Task Breakdown

### 5. Create EPUB Structure Generator 📁
**New Function**: `createEPUBStructure(zip)`

**EPUB Required Files**:
```
book.epub
├── mimetype               (must be first, uncompressed)
└── META-INF/
    └── container.xml
└── OEBPS/
    ├── content.opf       (package document)
    ├── toc.ncx          (navigation)
    ├── stylesheet.css
    ├── Images/
    │   └── page_001.png
    │   └── ...
    └── Text/
        └── page_001.xhtml
        └── ...
```

**mimetype file** (MUST be first, STORE compression):
```
application/epub+zip
```

**META-INF/container.xml**:
```xml
<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
```

---

### 6. Create EPUB content.opf Generator 📝
**New Function**: `generateContentOPF(metadata, toc, images)`

**content.opf Structure**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookID">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Book Title</dc:title>
    <dc:creator>Author Name</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID">kindle:ASIN</dc:identifier>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="stylesheet" href="stylesheet.css" media-type="text/css"/>
    <item id="page001" href="Text/page_001.xhtml" media-type="application/xhtml+xml"/>
    <item id="img001" href="Images/page_001.png" media-type="image/png"/>
    <!-- ... all pages and images -->
  </manifest>
  <spine toc="ncx">
    <itemref idref="page001"/>
    <!-- ... all pages in order -->
  </spine>
  <guide>
    <reference type="cover" title="Cover" href="Text/page_001.xhtml"/>
  </guide>
</package>
```

**Requirements**:
- Generate manifest entries for all images and XHTML pages
- Generate spine entries for reading order
- Use actual image format (png/jpeg/webp) in media-type
- Include CSS stylesheet reference

---

### 7. Create EPUB toc.ncx Generator 🗂️
**New Function**: `generateTocNCX(metadata, toc, pageData)`

**toc.ncx Structure**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="kindle:ASIN"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>Book Title</text>
  </docTitle>
  <navMap>
    <navPoint id="chapter1" playOrder="1">
      <navLabel>
        <text>Chapter 1: Title</text>
      </navLabel>
      <content src="Text/page_001.xhtml"/>
    </navPoint>
    <!-- ... chapters from toc.json -->
  </navMap>
</ncx>
```

**Requirements**:
- Map each entry from `toc.json` to a navPoint
- Use `toc[].label` for chapter title
- Map `toc[].tocPositionId` to corresponding page XHTML file
- Need helper function to find page index from position ID

---

### 8. Create EPUB XHTML Page Templates 📄
**New Function**: `generatePageXHTML(pageIndex, imageFilename, imageFormat)`

**XHTML Template for Each Page**:
```xhtml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Page {pageIndex}</title>
  <link rel="stylesheet" type="text/css" href="../stylesheet.css"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body>
  <div class="page">
    <img src="../Images/{imageFilename}" alt="Page {pageIndex}"/>
  </div>
</body>
</html>
```

**Requirements**:
- Generate one XHTML file per image
- Reference image with relative path
- Include viewport meta for mobile readers
- Link to stylesheet

---

### 9. Create EPUB CSS Stylesheet 🎨
**New Function**: `generateEPUBCSS()`

**stylesheet.css Content**:
```css
body {
  margin: 0;
  padding: 0;
  text-align: center;
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
  object-fit: contain;
}
```

**Requirements**:
- Center images on page
- Responsive images that fit screen
- No margins/padding for full-page manga display
- Support for various screen sizes

---

### 10. Implement EPUB Format Generator 📚
**New Function**: `generateEPUB(zip, metadata, toc, images, pageData)`

**Implementation Steps**:
1. Add mimetype file (STORE compression, must be first)
2. Add container.xml to META-INF/
3. Generate and add content.opf
4. Generate and add toc.ncx
5. Add stylesheet.css
6. Add all images to OEBPS/Images/
7. Generate and add XHTML pages to OEBPS/Text/
8. Return zip with proper EPUB structure

**Critical Requirements**:
- mimetype MUST be first file in ZIP
- mimetype MUST use STORE compression (no compression)
- All other files can use DEFLATE compression
- File paths must match references in content.opf

**JSZip Considerations**:
```javascript
// Ensure mimetype is first and uncompressed
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

// Add other files with compression
zip.file("META-INF/container.xml", containerXML, { compression: "DEFLATE" });
```

---

### 13. Add Chapter Boundary Detection 🔍
**New Function**: `mapLocationToPageIndex(locationMap, pageData, position)`

**Purpose**:
- Map TOC position IDs to actual page indices
- Required for EPUB navigation (toc.ncx)
- Required for CBZ chapter markers (if supported)

**Algorithm**:
```javascript
function mapLocationToPageIndex(locationMap, pageData, tocPosition) {
  // Find index of tocPosition in locationMap.locations
  const locationIndex = locationMap.locations.indexOf(tocPosition);
  
  // Find corresponding page in pageData
  // May need to use nearest page if exact match not found
  const page = pageData.find(p => /* match logic */);
  
  return page ? page.pageIndex : 0;
}
```

**Use Cases**:
- Generate EPUB toc.ncx with correct page references
- Display chapter progress during download
- Organize CBZ metadata with chapter markers

---

### 14. Test and Validate Generated Files ✅

**Testing Checklist**:

**CBZ Testing**:
- [ ] Open in Calibre
- [ ] Open in CDisplay Ex / YACReader
- [ ] Verify ComicInfo.xml is readable
- [ ] Verify images display in correct order
- [ ] Verify metadata shows correctly

**EPUB Testing**:
- [ ] Open in Calibre
- [ ] Open in Apple Books
- [ ] Open in Adobe Digital Editions
- [ ] Verify TOC navigation works
- [ ] Verify images display correctly
- [ ] Verify metadata shows correctly
- [ ] Run through EPUBCheck validator (online tool)

**Cross-Format Testing**:
- [ ] Test with small manga (5-10 pages)
- [ ] Test with large manga (100+ pages)
- [ ] Test with multiple chapters
- [ ] Verify file sizes are reasonable
- [ ] Verify download completes successfully
- [ ] Verify progress modal updates correctly

**Edge Cases**:
- [ ] Book with no chapter data
- [ ] Book with special characters in title
- [ ] Book with mixed image formats (PNG + JPEG)
- [ ] Very long book titles (filename sanitization)

---

## Implementation Priority

### Phase 1: CBZ Support (Easiest)
1. Task 1: Add format selection UI
2. Task 2: Create ComicInfo.xml generator
3. Task 3: Implement CBZ generator
4. Task 11: Refactor downloadImages
5. Task 12: Update confirmation dialog

### Phase 2: EPUB Support (More Complex)
6. Task 5: Create EPUB structure
7. Task 8: Create XHTML templates
8. Task 9: Create CSS stylesheet
9. Task 6: Create content.opf generator
10. Task 13: Add chapter boundary detection
11. Task 7: Create toc.ncx generator
12. Task 10: Implement EPUB generator

### Phase 3: Polish and Testing
13. Task 4: Document CBR decision
14. Task 14: Test and validate

---

## Technical Notes

### JSZip Considerations
- Current version: 3.9.1 (from CDN)
- Supports compression options per file
- EPUB requires mimetype as first file with STORE compression
- May need to use `generateAsync` with folder option for EPUB

### File Naming Convention
Current: `page_{pageIndex}_{elementId}.{format}`
- CBZ: Keep simple sequential: `page_001.png`, `page_002.png`
- EPUB: Separate images and XHTML, use same naming

### Metadata Extraction
Consider adding more metadata extraction:
- Publisher from bookInfo
- Publication date if available
- Language detection (currently hardcoded to 'en')
- Series information if available

### Future Enhancements
- Allow custom CSS for EPUB
- Add right-to-left reading mode option for EPUB
- Support for cover image selection
- Batch download multiple books
- Settings persistence (remember format preference)

---

## KPF (Kindle Create) Format Exploration

### Format Overview
KPF is Amazon's native format for Kindle Create, their modern authoring tool for publishing to Kindle Direct Publishing (KDP).

**Key Characteristics**:
- **Storage**: SQLite database containing KFX data
- **Content**: KFX (Kindle Format 10) - binary JSON variant
- **Purpose**: Professional publishing to Amazon's ecosystem
- **Status**: Proprietary format with limited documentation

### Research Summary
Comprehensive research has been conducted on KPF format feasibility. See detailed findings in:
📄 **[docs/KPF_FORMAT_RESEARCH.md](docs/KPF_FORMAT_RESEARCH.md)**

### Implementation Challenges
⚠️ **High Complexity** - Requires significant reverse engineering

1. **SQLite Schema**: Database structure not publicly documented
2. **KFX Encoding**: Proprietary binary JSON format (similar to Amazon ION)
3. **Manga Features**: Panel modes, double-page spreads, reading direction
4. **Image Format**: JXR (JPEG XR) encoding for optimal compression
5. **Maintenance**: Format may change with Kindle Create updates

### Feasibility Assessment
**Technical Difficulty**: 🔴🔴🔴🔴⚪ (4/5)  
**Time Estimate**: 4-8 weeks development + ongoing maintenance  
**Browser Compatibility**: Possible with sql.js (WASM SQLite)

### Recommendation
⚠️ **DEFER** - Implement CBZ and EPUB first

**Rationale**:
- CBZ/EPUB provide similar value with much less complexity
- Most users don't need KDP publishing workflow
- KPF is primarily valuable for Amazon KDP authors
- Reverse engineering effort is significant

### If KPF is Still Desired

**Approach 1: Direct SQLite Generation** (Recommended if pursuing)
- Reverse engineer KPF database schema
- Implement KFX binary JSON encoder
- Use sql.js for browser-based creation
- Time: 6-8 weeks

**Approach 2: Kindle Previewer Automation**
- Generate EPUB from downloaded manga
- Run Kindle Previewer 3 CLI to convert EPUB → KFX/KPF
- Requires local installation (cannot run in browser)
- Time: 2-3 weeks

**Approach 3: Kindle Create Automation** (Not Recommended)
- Automate Kindle Create GUI
- Very fragile, requires installation
- Time: 3-4 weeks

### Next Steps (If Pursuing KPF)
1. Create sample manga KPF files with Kindle Create
2. Analyze SQLite database schema
3. Study Calibre KFX plugin source code
4. Document minimal viable KPF structure
5. Implement proof-of-concept

### Decision Points
Before investing in KPF:
- **Use Case**: Personal reading or KDP publishing?
- **User Demand**: Do users specifically need KPF vs CBZ/EPUB?
- **Time Budget**: Is 4-8 weeks acceptable?
- **Maintenance**: Willingness to update as Amazon changes format?

**For personal manga reading/backup**: CBZ or EPUB recommended  
**For KDP manga publishing**: KPF would be valuable

---

## Resources

### Format Specifications
- [CBZ/CBR Format](https://wiki.mobileread.com/wiki/CBR_and_CBZ)
- [ComicInfo.xml Schema](https://github.com/anansi-project/comicinfo)
- [EPUB 2.0 Specification](http://idpf.org/epub/20/spec/OPF_2.0.1_draft.htm)
- [KFX Format - MobileRead Wiki](https://wiki.mobileread.com/wiki/KFX)
- [Amazon ION Format](https://amznlabs.github.io/ion-docs/) - KFX predecessor
- [EPUB Structure Guide](https://www.w3.org/publishing/epub3/epub-spec.html)

### Validation Tools
- [EPUBCheck](https://www.pagina.gmbh/produkte/epub-checker/)
- [EPUB Validator Online](https://validator.idpf.org/)

### Testing Software
- [Calibre](https://calibre-ebook.com/) - Universal eBook manager
- [YACReader](https://yacreader.com/) - Comic book reader
- [Adobe Digital Editions](https://www.adobe.com/solutions/ebook/digital-editions.html) - EPUB reader
