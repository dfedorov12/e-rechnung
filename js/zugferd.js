/**
 * ZUGFeRD 2.x / Factur-X PDF Generator
 * Embeds ZUGFeRD XML into an existing PDF via pdf-lib.
 *
 * PDF/A-3b conformance:
 *   – Correct XMP with PDF/A extension schema for fx: namespace
 *     (single consolidated rdf:Description for maximum validator compatibility)
 *   – sRGB ICC OutputIntent embedded in PDF catalog
 *     (satisfies ISO 19005-3 § 6.2.4.3 for DeviceRGB/DeviceGray in images)
 *   – DefaultRGB / DefaultGray CalRGB colour spaces on all pages
 *     (belt-and-suspenders fallback for content-stream colours)
 *
 * Known limitation: CIDSet font-descriptor errors in the source PDF
 *   cannot be repaired without re-rendering the original document.
 *
 * GuidelineID: urn:cen.eu:en16931:2017 (Mustang Profiles.java / ZUGFeRD 2.4 / Factur-X 1.08)
 */

/* ── sRGB IEC61966-2-1 ICC profile (Windows system, 3144 bytes) ────────── */
// Embedded to satisfy PDF/A-3 § 6.2.4.3 (DeviceRGB in image XObjects).
const _SRGB_ICC_B64 =
  'AAAMSExpbm8CEAAAbW50clJHQiBYWVogB84AAgAJAAYAMQAAYWNzcE1TRlQAAAAASUVDIHNSR0IA' +
  'AAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1IUCAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAARY3BydAAAAVAAAAAzZGVzYwAAAYQAAABsd3RwdAAAAfAAAAAUYmtw' +
  'dAAAAgQAAAAUclhZWgAAAhgAAAAUZ1hZWgAAAiwAAAAUYlhZWgAAAkAAAAAUZG1uZAAAAlQAAABw' +
  'ZG1kZAAAAsQAAACIdnVlZAAAA0wAAACGdmlldwAAA9QAAAAkbHVtaQAAA/gAAAAUbWVhcwAABAwA' +
  'AAAkdGVjaAAABDAAAAAMclRSQwAABDwAAAgMZ1RSQwAABDwAAAgMYlRSQwAABDwAAAgMdGV4dAAA' +
  'AABDb3B5cmlnaHQgKGMpIDE5OTggSGV3bGV0dC1QYWNrYXJkIENvbXBhbnkAAGRlc2MAAAAAAAAA' +
  'EnNSR0IgSUVDNjE5NjYtMi4xAAAAAAAAAAAAAAASc1JHQiBJRUM2MTk2Ni0yLjEAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAADzUQABAAAA' +
  'ARbMWFlaIAAAAAAAAAAAAAAAAAAAAABYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAA' +
  't4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9kZXNjAAAAAAAAABZJRUMgaHR0cDovL3d3dy5pZWMu' +
  'Y2gAAAAAAAAAAAAAABZJRUMgaHR0cDovL3d3dy5pZWMuY2gAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZGVzYwAAAAAAAAAuSUVDIDYxOTY2LTIuMSBEZWZhdWx0' +
  'IFJHQiBjb2xvdXIgc3BhY2UgLSBzUkdCAAAAAAAAAAAAAAAuSUVDIDYxOTY2LTIuMSBEZWZhdWx0' +
  'IFJHQiBjb2xvdXIgc3BhY2UgLSBzUkdCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGRlc2MAAAAAAAAA' +
  'LFJlZmVyZW5jZSBWaWV3aW5nIENvbmRpdGlvbiBpbiBJRUM2MTk2Ni0yLjEAAAAAAAAAAAAAACxS' +
  'ZWZlcmVuY2UgVmlld2luZyBDb25kaXRpb24gaW4gSUVDNjE5NjYtMi4xAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAB2aWV3AAAAAAATpP4AFF8uABDPFAAD7cwABBMLAANcngAAAAFYWVogAAAAAABM' +
  'CVYAUAAAAFcf521lYXMAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAKPAAAAAnNpZyAAAAAAQ1JU' +
  'IGN1cnYAAAAAAAAEAAAAAAUACgAPABQAGQAeACMAKAAtADIANwA7AEAARQBKAE8AVABZAF4AYwBo' +
  'AG0AcgB3AHwAgQCGAIsAkACVAJoAnwCkAKkArgCyALcAvADBAMYAywDQANUA2wDgAOUA6wDwAPYA' +
  '+wEBAQcBDQETARkBHwElASsBMgE4AT4BRQFMAVIBWQFgAWcBbgF1AXwBgwGLAZIBmgGhAakBsQG5' +
  'AcEByQHRAdkB4QHpAfIB+gIDAgwCFAIdAiYCLwI4AkECSwJUAl0CZwJxAnoChAKOApgCogKsArYC' +
  'wQLLAtUC4ALrAvUDAAMLAxYDIQMtAzgDQwNPA1oDZgNyA34DigOWA6IDrgO6A8cD0wPgA+wD+QQG' +
  'BBMEIAQtBDsESARVBGMEcQR+BIwEmgSoBLYExATTBOEE8AT+BQ0FHAUrBToFSQVYBWcFdwWGBZYF' +
  'pgW1BcUF1QXlBfYGBgYWBicGNwZIBlkGagZ7BowGnQavBsAG0QbjBvUHBwcZBysHPQdPB2EHdAeG' +
  'B5kHrAe/B9IH5Qf4CAsIHwgyCEYIWghuCIIIlgiqCL4I0gjnCPsJEAklCToJTwlkCXkJjwmkCboJ' +
  'zwnlCfsKEQonCj0KVApqCoEKmAquCsUK3ArzCwsLIgs5C1ELaQuAC5gLsAvIC+EL+QwSDCoMQwxc' +
  'DHUMjgynDMAM2QzzDQ0NJg1ADVoNdA2ODakNww3eDfgOEw4uDkkOZA5/DpsOtg7SDu4PCQ8lD0EP' +
  'Xg96D5YPsw/PD+wQCRAmEEMQYRB+EJsQuRDXEPURExExEU8RbRGMEaoRyRHoEgcSJhJFEmQShBKj' +
  'EsMS4xMDEyMTQxNjE4MTpBPFE+UUBhQnFEkUahSLFK0UzhTwFRIVNBVWFXgVmxW9FeAWAxYmFkkW' +
  'bBaPFrIW1hb6Fx0XQRdlF4kXrhfSF/cYGxhAGGUYihivGNUY+hkgGUUZaxmRGbcZ3RoEGioaURp3' +
  'Gp4axRrsGxQbOxtjG4obshvaHAIcKhxSHHscoxzMHPUdHh1HHXAdmR3DHeweFh5AHmoelB6+Hukf' +
  'Ex8+H2kflB+/H+ogFSBBIGwgmCDEIPAhHCFIIXUhoSHOIfsiJyJVIoIiryLdIwojOCNmI5QjwiPw' +
  'JB8kTSR8JKsk2iUJJTglaCWXJccl9yYnJlcmhya3JugnGCdJJ3onqyfcKA0oPyhxKKIo1CkGKTgp' +
  'aymdKdAqAio1KmgqmyrPKwIrNitpK50r0SwFLDksbiyiLNctDC1BLXYtqy3hLhYuTC6CLrcu7i8k' +
  'L1ovkS/HL/4wNTBsMKQw2zESMUoxgjG6MfIyKjJjMpsy1DMNM0YzfzO4M/E0KzRlNJ402DUTNU01' +
  'hzXCNf02NzZyNq426TckN2A3nDfXOBQ4UDiMOMg5BTlCOX85vDn5OjY6dDqyOu87LTtrO6o76Dwn' +
  'PGU8pDzjPSI9YT2hPeA+ID5gPqA+4D8hP2E/oj/iQCNAZECmQOdBKUFqQaxB7kIwQnJCtUL3QzpD' +
  'fUPARANER0SKRM5FEkVVRZpF3kYiRmdGq0bwRzVHe0fASAVIS0iRSNdJHUljSalJ8Eo3Sn1KxEsM' +
  'S1NLmkviTCpMcky6TQJNSk2TTdxOJU5uTrdPAE9JT5NP3VAnUHFQu1EGUVBRm1HmUjFSfFLHUxNT' +
  'X1OqU/ZUQlSPVNtVKFV1VcJWD1ZcVqlW91dEV5JX4FgvWH1Yy1kaWWlZuFoHWlZaplr1W0VblVvl' +
  'XDVchlzWXSddeF3JXhpebF69Xw9fYV+zYAVgV2CqYPxhT2GiYfViSWKcYvBjQ2OXY+tkQGSUZOll' +
  'PWWSZedmPWaSZuhnPWeTZ+loP2iWaOxpQ2maafFqSGqfavdrT2una/9sV2yvbQhtYG25bhJua27E' +
  'bx5veG/RcCtwhnDgcTpxlXHwcktypnMBc11zuHQUdHB0zHUodYV14XY+dpt2+HdWd7N4EXhueMx5' +
  'KnmJeed6RnqlewR7Y3vCfCF8gXzhfUF9oX4BfmJ+wn8jf4R/5YBHgKiBCoFrgc2CMIKSgvSDV4O6' +
  'hB2EgITjhUeFq4YOhnKG14c7h5+IBIhpiM6JM4mZif6KZIrKizCLlov8jGOMyo0xjZiN/45mjs6P' +
  'No+ekAaQbpDWkT+RqJIRknqS45NNk7aUIJSKlPSVX5XJljSWn5cKl3WX4JhMmLiZJJmQmfyaaJrV' +
  'm0Kbr5wcnImc951kndKeQJ6unx2fi5/6oGmg2KFHobaiJqKWowajdqPmpFakx6U4pammGqaLpv2n' +
  'bqfgqFKoxKk3qamqHKqPqwKrdavprFys0K1ErbiuLa6hrxavi7AAsHWw6rFgsdayS7LCszizrrQl' +
  'tJy1E7WKtgG2ebbwt2i34LhZuNG5SrnCuju6tbsuu6e8IbybvRW9j74KvoS+/796v/XAcMDswWfB' +
  '48JfwtvDWMPUxFHEzsVLxcjGRsbDx0HHv8g9yLzJOsm5yjjKt8s2y7bMNcy1zTXNtc42zrbPN8+4' +
  '0DnQutE80b7SP9LB00TTxtRJ1MvVTtXR1lXW2Ndc1+DYZNjo2WzZ8dp22vvbgNwF3IrdEN2W3hze' +
  'ot8p36/gNuC94UThzOJT4tvjY+Pr5HPk/OWE5g3mlucf56noMui86Ubp0Opb6uXrcOv77IbtEe2c' +
  '7ijutO9A78zwWPDl8XLx//KM8xnzp/Q09ML1UPXe9m32+/eK+Bn4qPk4+cf6V/rn+3f8B/yY/Sn9' +
  'uv5L/tz/bf//';
function _base64ToBytes(b64) {
  const clean = b64.replace(/\s/g, '');
  const bin   = atob(clean);
  const out   = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Main entry point ────────────────────────────────────────────────── */

async function embedXMLIntoPDF(pdfBytes, xmlString, profile) {
  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const xmlBytes = new TextEncoder().encode(xmlString);

  const isZugferd = profile === 'zugferd';
  const filename    = isZugferd ? 'factur-x.xml' : 'xrechnung.xml';
  const description = isZugferd
    ? 'ZUGFeRD/Factur-X Rechnung (EN 16931)'
    : 'XRechnung 3.0';

  // Embed XML as attachment (afRelationship=Alternative required by ZUGFeRD/Factur-X)
  await pdfDoc.attach(xmlBytes, filename, {
    mimeType:         'text/xml',
    description,
    creationDate:     new Date(),
    modificationDate: new Date(),
    afRelationship:   'Alternative',
  });

  if (isZugferd) {
    // 1. sRGB ICC OutputIntent — satisfies ISO 19005-3 §6.2.4.3 for all DeviceRGB/DeviceGray
    _addOutputIntent(pdfDoc);

    // 2. Replace XMP metadata with PDF/A-3b + Factur-X conformant block
    _setZUGFeRDXMP(pdfDoc, filename);

    // 3. DefaultRGB / DefaultGray on page Resources (belt-and-suspenders for content streams)
    _pdfaColorSpaceFix(pdfDoc);
  }

  pdfDoc.setTitle(pdfDoc.getTitle() || 'E-Rechnung');
  pdfDoc.setCreator('E-Rechnung Konverter (DIHAG)');
  pdfDoc.setProducer('pdf-lib + ZUGFeRD/Factur-X Generator');
  pdfDoc.setModificationDate(new Date());

  return await pdfDoc.save();
}

/* ── ICC OutputIntent ────────────────────────────────────────────────── */

/**
 * Embeds the sRGB IEC61966-2-1 ICC profile as an OutputIntent in the PDF catalog.
 * This declares DeviceRGB/DeviceGray as sRGB-mapped, satisfying PDF/A-3 §6.2.4.3
 * for image XObjects that carry their own /ColorSpace /DeviceRGB declarations.
 */
function _addOutputIntent(pdfDoc) {
  try {
    const PDFName = PDFLib.PDFName;

    const iccBytes = _base64ToBytes(_SRGB_ICC_B64);

    // ICC profile stream: N=3 (RGB components)
    const iccStream = pdfDoc.context.stream(iccBytes, { N: 3 });
    const iccRef    = pdfDoc.context.register(iccStream);

    // OutputIntent dictionary (GTS_PDFA1 is the PDF/A identifier)
    const oi = pdfDoc.context.obj({
      Type:                      PDFName.of('OutputIntent'),
      S:                         PDFName.of('GTS_PDFA1'),
      OutputConditionIdentifier: PDFLib.PDFString.of('sRGB IEC61966-2-1'),
      Info:                      PDFLib.PDFString.of('sRGB IEC61966-2-1'),
      DestOutputProfile:         iccRef,
    });
    const oiRef = pdfDoc.context.register(oi);

    // Overwrite (or create) OutputIntents array in catalog
    pdfDoc.catalog.set(PDFName.of('OutputIntents'), pdfDoc.context.obj([oiRef]));
  } catch (e) {
    console.warn('OutputIntent not added:', e.message);
  }
}

/* ── XMP ─────────────────────────────────────────────────────────────── */

function _setZUGFeRDXMP(pdfDoc, filename) {
  const xmpBytes = new TextEncoder().encode(_buildZUGFeRDXMP(filename));
  // Type/Subtype are required by PDF/A-3 for the Metadata stream
  const stream = pdfDoc.context.stream(xmpBytes, {
    Type:    PDFLib.PDFName.of('Metadata'),
    Subtype: PDFLib.PDFName.of('XML'),
  });
  pdfDoc.catalog.set(PDFLib.PDFName.of('Metadata'), pdfDoc.context.register(stream));
}

/**
 * Builds a PDF/A-3b + Factur-X conformant XMP metadata block.
 *
 * Uses a single consolidated rdf:Description with all namespace declarations
 * (maximises compatibility with strict validators such as veraPDF).
 *
 * The pdfaExtension:schemas section declares the fx: namespace so that
 * veraPDF / EU-Rechnung do not flag the four Factur-X properties as unknown.
 *
 * GuidelineID in the embedded XML: urn:cen.eu:en16931:2017
 * (as defined in Mustang Profiles.java for ZUGFeRD 2.4 / Factur-X 1.08)
 */
function _buildZUGFeRDXMP(filename) {
  const now = new Date().toISOString();
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">

    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">

      <!-- PDF/A-3b identification -->
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>

      <!-- Dublin Core -->
      <dc:format>application/pdf</dc:format>

      <!-- XMP basic -->
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
      <xmp:CreatorTool>E-Rechnung Konverter (DIHAG)</xmp:CreatorTool>

      <!-- Factur-X / ZUGFeRD invoice metadata -->
      <fx:DocumentFileName>${filename}</fx:DocumentFileName>
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>

      <!-- PDF/A extension schema: declares the fx: namespace to avoid
           "XMP property not predefined" errors in veraPDF / EU-Rechnung -->
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>name of the embedded XML invoice file</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>INVOICE</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The actual version of the ZUGFeRD data</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The conformance level of the embedded ZUGFeRD data</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>

    </rdf:Description>

  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ── PDF/A colour-space fix (content streams) ────────────────────────── */

/**
 * Adds DefaultRGB (CalRGB/sRGB) and DefaultGray (CalGray) to every page's
 * Resource/ColorSpace dictionary.
 *
 * With an OutputIntent present (see _addOutputIntent), this is technically
 * redundant, but it acts as belt-and-suspenders for validators that check
 * colour operators in content streams independently.
 *
 * Note: CIDSet font-descriptor issues in the source PDF cannot be fixed here.
 */
function _pdfaColorSpaceFix(pdfDoc) {
  const PDFName = PDFLib.PDFName;
  const PDFDict = PDFLib.PDFDict;

  // sRGB approximation via CalRGB (ITU-R BT.709 primaries, D65 white point, γ 2.2)
  const calRGBDef = [
    PDFName.of('CalRGB'),
    {
      WhitePoint: [0.95045, 1.0, 1.08905],
      Gamma:      [2.2, 2.2, 2.2],
      Matrix:     [
        0.4124, 0.2126, 0.0193,
        0.3576, 0.7152, 0.1192,
        0.1805, 0.0722, 0.9505,
      ],
    },
  ];

  const calGrayDef = [
    PDFName.of('CalGray'),
    {
      WhitePoint: [0.95045, 1.0, 1.08905],
      Gamma: 2.2,
    },
  ];

  for (let i = 0; i < pdfDoc.getPageCount(); i++) {
    try {
      const resources = pdfDoc.getPage(i).node.Resources();
      if (!resources) continue;

      let cs = resources.lookup(PDFName.of('ColorSpace'));
      if (!(cs instanceof PDFDict)) {
        cs = pdfDoc.context.obj({});
        resources.set(PDFName.of('ColorSpace'), cs);
      }

      if (!cs.has(PDFName.of('DefaultRGB'))) {
        cs.set(PDFName.of('DefaultRGB'), pdfDoc.context.obj(calRGBDef));
      }
      if (!cs.has(PDFName.of('DefaultGray'))) {
        cs.set(PDFName.of('DefaultGray'), pdfDoc.context.obj(calGrayDef));
      }
    } catch (e) {
      console.warn(`PDF/A colour space: page ${i} skipped —`, e.message);
    }
  }
}

/* ── Download helpers ────────────────────────────────────────────────── */

function downloadBlob(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadText(text, filename) {
  const blob = new Blob(['﻿' + text], { type: 'text/xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bytesToBase64(bytes) {
  let binary = '';
  const len  = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
