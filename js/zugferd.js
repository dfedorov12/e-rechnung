/**
 * ZUGFeRD 2.x / Factur-X PDF Generator
 * Embeds ZUGFeRD XML into an existing PDF via pdf-lib.
 * PDF/A-3b conformance improvements:
 *   – Correct XMP with PDF/A extension schema for fx: namespace
 *   – DefaultRGB / DefaultGray CalRGB colour spaces on all pages
 *     (fixes ISO 19005-3 Rule 6.2.4.3 DeviceRGB/DeviceGray without OutputIntent)
 * Known limitation: CIDSet font-descriptor errors in the source PDF
 *   cannot be repaired without re-rendering the original document.
 */

async function embedXMLIntoPDF(pdfBytes, xmlString, profile) {
  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const xmlBytes = new TextEncoder().encode(xmlString);

  const isZugferd = profile === 'zugferd';
  const filename    = isZugferd ? 'factur-x.xml' : 'xrechnung.xml';
  const description = isZugferd
    ? 'ZUGFeRD/Factur-X Rechnung (EN 16931)'
    : 'XRechnung 3.0';

  // Embed XML as attachment with afRelationship=Alternative (required by ZUGFeRD/Factur-X)
  await pdfDoc.attach(xmlBytes, filename, {
    mimeType:         'text/xml',
    description,
    creationDate:     new Date(),
    modificationDate: new Date(),
    afRelationship:   'Alternative',
  });

  if (isZugferd) {
    // 1. Replace XMP metadata with a fully PDF/A-3b + Factur-X conformant block
    _setZUGFeRDXMP(pdfDoc, filename);

    // 2. Add DefaultRGB / DefaultGray to every page's Resources/ColorSpace
    //    This satisfies ISO 19005-3:2012 § 6.2.4.3 without needing an ICC output intent.
    _pdfaColorSpaceFix(pdfDoc);
  }

  pdfDoc.setTitle(pdfDoc.getTitle() || 'E-Rechnung');
  pdfDoc.setCreator('E-Rechnung Konverter (DIHAG)');
  pdfDoc.setProducer('pdf-lib + ZUGFeRD/Factur-X Generator');
  pdfDoc.setModificationDate(new Date());

  return await pdfDoc.save();
}

/* ── XMP ─────────────────────────────────────────────────────────────── */

function _setZUGFeRDXMP(pdfDoc, filename) {
  try {
    const xmpBytes = new TextEncoder().encode(_buildZUGFeRDXMP(filename));
    const stream   = pdfDoc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' });
    pdfDoc.catalog.set(PDFLib.PDFName.of('Metadata'), pdfDoc.context.register(stream));
  } catch (e) {
    console.warn('ZUGFeRD XMP not injected:', e.message);
  }
}

/**
 * Builds a PDF/A-3b + Factur-X conformant XMP metadata block.
 * The pdfaExtension:schemas section declares the custom fx: namespace
 * so that veraPDF and EU-Rechnung do not flag the properties as unknown.
 */
function _buildZUGFeRDXMP(filename) {
  const now = new Date().toISOString();
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">

    <rdf:Description rdf:about=""
        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>

    <rdf:Description rdf:about=""
        xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentFileName>${filename}</fx:DocumentFileName>
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
    </rdf:Description>

    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
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

    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
    </rdf:Description>

    <rdf:Description rdf:about=""
        xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
      <xmp:CreatorTool>E-Rechnung Konverter (DIHAG)</xmp:CreatorTool>
    </rdf:Description>

  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ── PDF/A colour-space fix ──────────────────────────────────────────── */

/**
 * Adds DefaultRGB (CalRGB/sRGB) and DefaultGray (CalGray) entries to every
 * page's Resource/ColorSpace dictionary.
 *
 * ISO 19005-3:2012 § 6.2.4.3 allows DeviceRGB/DeviceGray when a device-
 * independent DefaultRGB/DefaultGray is set in the current colour space
 * resource — no ICC output intent required.
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
