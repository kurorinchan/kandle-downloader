# KPF (Kindle Create) Format Research

## Research Date
March 10, 2026

## Executive Summary

**Format**: KPF (Kindle Package Format)  
**Purpose**: Native format for Amazon's Kindle Create authoring tool  
**Structure**: SQLite database containing KFX data  
**Status**: Proprietary Amazon format with limited public documentation  

**Feasibility Assessment**: ⚠️ **CHALLENGING BUT POTENTIALLY POSSIBLE**

---

## What is KPF?

KPF is Amazon's package format for Kindle Create, their modern authoring tool that replaced KindleGen. It serves as a container for KFX content.

### Key Characteristics

1. **Storage Format**: SQLite database file
2. **Content Format**: KFX (Kindle Format 10) data
3. **Data Encoding**: Binary JSON variant (similar to Amazon ION format)
4. **Primary Use**: Authoring and packaging books for Kindle Direct Publishing (KDP)
5. **Replaces**: KindleGen (.mobi workflow)

---

## KFX Format Overview

Since KPF contains KFX data, understanding KFX is essential:

### KFX Features (Relevant to Manga)

- **Image Format**: JXR (JPEG XR) with higher compression than traditional formats
- **Manga-Specific Features**:
  - Panel viewing modes
  - Page and panel viewing modes
  - Double-page spread support
  - Right-to-left reading direction support
  - Dedicated manga menu interface
- **Enhanced Typesetting**: Advanced layout engine
- **Resource Management**: Efficient asset packaging with CDN integration

### KFX File Structure

KFX content typically consists of:
- Main container (encrypted/compressed)
- Resource containers (images, fonts, etc.)
- Metadata containers
- DRM vouchers (for purchased content)

---

## Technical Challenges

### 1. Format Complexity
- **Binary JSON**: KFX uses a proprietary binary JSON encoding (possibly based on Amazon ION)
- **Limited Documentation**: No official public specification from Amazon
- **Reverse Engineering Required**: Format details known primarily through community reverse engineering

### 2. SQLite Database Structure
- **Unknown Schema**: KPF database table structure not publicly documented
- **Data Relationships**: Unclear how images, metadata, and content are linked
- **Version Compatibility**: Amazon may change schema without notice

### 3. Image Handling
- **JXR Format**: Would require JXR encoding support
- **Compression**: Need to understand optimal compression settings
- **Metadata**: Image dimensions, DPI, color profiles must be preserved

### 4. Manga-Specific Requirements
- **Page Layout**: Double-page spreads, panel detection
- **Reading Direction**: Right-to-left vs left-to-right
- **Navigation**: Page flip modes, panel zoom
- **Table of Contents**: Chapter/volume organization

---

## Existing Tools & Libraries

### Reverse Engineering Community

**MobileRead Forums**: Active community discussing Kindle formats
- KFX Input Plugin (Calibre): Can read KFX files
- KFX Output Plugin (Calibre): Can create KFX files via Kindle Previewer 3
- DeDRM tools: Handle various Kindle formats (though KFX DRM frequently changes)

### Kindle Previewer 3

Amazon's official preview tool:
- Can convert EPUB → KFX
- Can open KPF files
- Uses internal conversion engine
- **Limitation**: Doesn't directly support creating KPF from images

### Kindle Create

Amazon's official authoring tool:
- Creates KPF files natively
- Supports comics/manga import
- Handles image books
- **Limitation**: Requires manual import through GUI

---

## Potential Implementation Approaches

### Approach 1: SQLite Database Creation ⭐ (Recommended)

**Strategy**: Reverse engineer KPF SQLite schema and create database directly

**Pros**:
- Most direct approach
- Full control over output format
- Could be integrated into userscript (if using Node.js/WASM SQLite)

**Cons**:
- Requires reverse engineering effort
- Schema may change between Kindle Create versions
- KFX binary JSON encoding is complex

**Steps**:
1. Analyze existing KPF files created by Kindle Create
2. Document SQLite schema (tables, columns, indexes)
3. Understand KFX binary JSON encoding for metadata
4. Implement image packaging with JXR encoding
5. Create table relationships and metadata
6. Generate valid KPF file

### Approach 2: Kindle Previewer 3 Automation ⚠️

**Strategy**: Create intermediate format (EPUB) and use Kindle Previewer to convert

**Pros**:
- Leverages official Amazon tooling
- KFX generation handled by Amazon code
- Less reverse engineering required

**Cons**:
- Requires Kindle Previewer 3 installation
- Cannot run in browser (would need separate conversion step)
- Automation may break with updates
- EPUB → KFX conversion may not optimize for manga

**Steps**:
1. Generate manga EPUB from downloaded images
2. Call Kindle Previewer 3 CLI to convert EPUB → KFX
3. Package as KPF if needed

### Approach 3: Kindle Create Automation ❌ (Not Recommended)

**Strategy**: Automate Kindle Create GUI

**Pros**:
- Uses official KPF creation tool

**Cons**:
- Requires GUI automation (Selenium, PyAutoGUI)
- Very fragile
- Cannot run in browser
- User must have Kindle Create installed

---

## Data We Already Have

Your manga downloader already extracts all necessary data:

✅ **Images**: Downloaded and decrypted manga pages  
✅ **Metadata**: Book title, authors, ASIN  
✅ **Table of Contents**: Chapter structure from toc.json  
✅ **Page Order**: locationMap provides sequential page data  
✅ **Image Detection**: Format detection (PNG, JPG) already implemented  

### What's Missing for KPF

❌ **KFX Encoding**: Binary JSON encoder for metadata  
❌ **SQLite Schema**: KPF database structure  
❌ **JXR Encoding**: Image conversion (optional - could use PNG/JPG)  
❌ **Manga Layout**: Page spread configuration, reading direction  

---

## Recommended Next Steps

### Phase 1: Research & Analysis (1-2 weeks)

1. **Obtain Sample KPF Files**
   - Create test manga KPF using Kindle Create
   - Vary: single page, double page, different image counts
   - Document what Kindle Create requires as input

2. **Analyze SQLite Structure**
   ```bash
   sqlite3 sample.kpf .schema
   sqlite3 sample.kpf "SELECT name FROM sqlite_master WHERE type='table';"
   ```
   
3. **Study Existing Tools**
   - Review Calibre KFX Input/Output plugin source code
   - Check MobileRead forums for KPF-specific discussions
   - Look for KFX JSON schema documentation

### Phase 2: Proof of Concept (2-3 weeks)

1. **Simple KPF Generation**
   - Create minimal KPF with 2-3 manga pages
   - Test in Kindle Previewer 3 and actual Kindle device
   - Validate reading experience

2. **Test Critical Features**
   - Double-page spreads
   - Right-to-left reading
   - TOC/chapter navigation

### Phase 3: Integration (1-2 weeks)

1. **JavaScript SQLite Library**
   - Evaluate sql.js (SQLite compiled to WebAssembly)
   - Implement KPF database generation in browser

2. **KFX Encoding**
   - Either: Use simplified metadata (may work)
   - Or: Implement minimal KFX binary JSON encoder
   - Or: Bundle pre-built KFX templates

---

## Feasibility Assessment

### Technical Feasibility: 6/10

**Possible but requires significant reverse engineering effort**

- SQLite database creation: Easy (libraries available)
- Schema documentation: Medium (requires analysis)
- KFX encoding: Hard (proprietary binary format)
- Browser integration: Medium (WASM SQLite available)

### Time Estimate

- **Minimal Implementation**: 3-4 weeks
- **Full Featured**: 6-8 weeks
- **Ongoing Maintenance**: Schema may change with Kindle Create updates

### Alternative: Simpler Formats

Consider implementing these first (easier, more universally compatible):

1. **CBZ** (Comic Book ZIP): ✅ Already planned in FEATURE_PLAN.md
2. **EPUB with Fixed Layout**: Standard format, widely supported
3. **PDF**: Simple, universal, but limited interactivity

**Recommendation**: Implement CBZ first, then EPUB, then consider KPF if there's strong demand.

---

## Resources & References

### Documentation
- [MobileRead Wiki - KFX Format](https://wiki.mobileread.com/wiki/KFX)
- [MobileRead Forums - KFX Discussion](https://www.mobileread.com/forums/showthread.php?t=272407)
- [Amazon Ion Format](https://amznlabs.github.io/ion-docs/) - KFX predecessor

### Tools
- **Kindle Previewer 3**: [Amazon Download](https://kdp.amazon.com/en_US/help/topic/G202131100)
- **Kindle Create**: [Amazon Download](https://kdp.amazon.com/en_US/help/topic/G202131100)
- **Calibre KFX Plugin**: [MobileRead Thread](https://www.mobileread.com/forums/showthread.php?t=291290)
- **sql.js**: [Browser SQLite via WASM](https://github.com/sql-js/sql.js)

### Community
- MobileRead Forums - Primary community for ebook format reverse engineering
- #mobileread IRC channel
- DeDRM Tools community (GitHub)

---

## Conclusion

**KPF creation is technically feasible but challenging.** It requires:

1. Reverse engineering the SQLite schema
2. Understanding KFX binary JSON encoding
3. Browser-compatible implementation (WASM SQLite)
4. Ongoing maintenance as Amazon updates formats

**Recommendation**: 
- Start with CBZ format (much easier, widely compatible)
- Implement EPUB with fixed layout for kindle compatibility
- Consider KPF as a "stretch goal" if there's strong user demand and time for reverse engineering

**User Value**:
- KPF files work natively with Kindle Create and KDP publishing workflow
- Most users would be satisfied with CBZ (for reading) or EPUB (for compatibility)
- KPF is primarily valuable for those wanting to publish manga on KDP

---

## Questions to User

Before investing significant time in KPF implementation:

1. **Primary Use Case**: Do you want KPF for personal reading or KDP publishing?
2. **User Base**: Would your users need KPF specifically, or would CBZ/EPUB suffice?
3. **Time Investment**: Is the 4-8 week development time acceptable?
4. **Maintenance**: Are you willing to maintain KPF support as Amazon changes formats?

If the goal is primarily **backup and personal reading**, CBZ or EPUB would be more practical choices.
