/**
 * ZUGFeRD 2.3 PDF Generator
 * Embeds XRechnung/ZUGFeRD XML into an existing PDF via pdf-lib
 * Konformität: EN 16931 COMFORT (Factur-X)
 */

async function embedXMLIntoPDF(pdfBytes, xmlString, profile) {
  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRawStream } = PDFLib;

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const xmlBytes = new TextEncoder().encode(xmlString);

  const isZugferd = profile === 'zugferd';
  const filename = isZugferd ? 'factur-x.xml' : 'xrechnung.xml';
  const description = isZugferd ? 'ZUGFeRD/Factur-X Rechnung (EN 16931)' : 'XRechnung 3.0';

  await pdfDoc.attach(xmlBytes, filename, {
    mimeType: 'text/xml',
    description: description,
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: 'Alternative',
  });

  // Add ZUGFeRD/Factur-X XMP metadata to make it recognizable
  if (isZugferd) {
    const xmpMeta = buildZUGFeRDXMP(filename);
    const catalog = pdfDoc.catalog;

    // Try to set XMP metadata
    try {
      const metadataStream = pdfDoc.context.stream(
        new TextEncoder().encode(xmpMeta),
        {
          Type: 'Metadata',
          Subtype: 'XML',
        }
      );
      catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(metadataStream));
    } catch (e) {
      // XMP metadata injection failed — PDF is still valid with attached XML
      console.warn('XMP metadata not injected:', e.message);
    }
  }

  pdfDoc.setTitle(pdfDoc.getTitle() || 'E-Rechnung');
  pdfDoc.setCreator('E-Rechnung Konverter (DIHAG)');
  pdfDoc.setProducer('pdf-lib + XRechnung/ZUGFeRD Generator');
  pdfDoc.setModificationDate(new Date());

  return await pdfDoc.save();
}

function buildZUGFeRDXMP(filename) {
  const now = new Date().toISOString();
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentFileName>${filename}</fx:DocumentFileName>
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
      xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about=""
      xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
    </rdf:Description>
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:ModifyDate>${now}</xmp:ModifyDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function downloadBlob(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadText(text, filename) {
  const blob = new Blob(['﻿' + text], { type: 'text/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
