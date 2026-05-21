// Seed source for the e-sign Service Agreement.
//
// As of migration 003 the live contract lives in the `contract_versions` DB
// table and is managed from the owner admin UI. This module only provides the
// INITIAL v1 contract (the .md file shipped with the code) used to seed the DB
// on first run — see lib/documents.js seedInitialContract().
//
// Do not edit service-agreement-v1.md after clients have signed it: signature
// records store a hash of the exact text. New contracts are uploaded via the
// admin, not by editing files here.

const fs = require('fs');
const path = require('path');

const SEED_CONTRACT_VERSION = 'v1';
const SEED_CONTRACT_TITLE = 'SoCal Receptionist — Service Agreement';
const SEED_CONTRACT_FILE = 'service-agreement-v1.md';

// The e-signature disclosure shown to, and agreed to by, every signer. Stored
// verbatim with each signature record so the consent language is auditable.
const ESIGN_CONSENT_TEXT =
  'I consent to do business electronically. By typing my full legal name and ' +
  'clicking "Sign & Agree", I am electronically signing the SoCal Receptionist ' +
  'Service Agreement, I confirm I am authorized to bind the business, and I ' +
  'agree this electronic signature has the same legal effect as a handwritten ' +
  'signature under the federal ESIGN Act and the California Uniform Electronic ' +
  'Transactions Act (UETA).';

// Raw markdown of the initial contract, read from the shipped file.
function getSeedContractBody() {
  return fs.readFileSync(path.join(__dirname, SEED_CONTRACT_FILE), 'utf8');
}

module.exports = {
  SEED_CONTRACT_VERSION,
  SEED_CONTRACT_TITLE,
  ESIGN_CONSENT_TEXT,
  getSeedContractBody,
};
