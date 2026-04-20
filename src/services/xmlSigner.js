/**
 * XML-DSIG signer for eSocial messages.
 * Signs the inner <eSocial> element using the PFX certificate and embeds
 * the Signature as the last child of <eSocial>.
 */

const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');

/**
 * Extract private key (PEM) and certificate (PEM) from a PFX/P12 buffer.
 */
function extractPemFromPfx(pfxBuffer, password) {
  const p12Der = forge.util.createBuffer(pfxBuffer.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

  let privateKey = null;
  let cert = null;

  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag ||
          safeBag.type === forge.pki.oids.keyBag) {
        privateKey = safeBag.key;
      } else if (safeBag.type === forge.pki.oids.certBag) {
        if (!cert) cert = safeBag.cert;
      }
    }
  }

  if (!privateKey || !cert) {
    throw new Error('PFX não contém chave privada ou certificado');
  }

  const keyPem = forge.pki.privateKeyToPem(privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  // Extract base64 certificate without BEGIN/END lines (for X509Data)
  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  return { keyPem, certPem, certBase64 };
}

/**
 * Sign the <eSocial> element inside the given XML string.
 * Returns the signed XML.
 */
function signEsocialXml(xmlString, pfxBuffer, password) {
  const { keyPem, certBase64 } = extractPemFromPfx(pfxBuffer, password);

  const sig = new SignedXml({
    privateKey: keyPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });

  sig.addReference({
    xpath: "//*[local-name(.)='eSocial']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    uri: '',
  });

  sig.getKeyInfoContent = () => {
    return `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`;
  };

  sig.computeSignature(xmlString, {
    location: { reference: "//*[local-name(.)='eSocial']", action: 'append' },
  });

  return sig.getSignedXml();
}

module.exports = { signEsocialXml, extractPemFromPfx };
