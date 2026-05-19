#!/usr/bin/env node
/**
 * provision.js — Spin up a new SoCal Receptionist instance for a client.
 *
 * Usage:
 *   node scripts/provision.js
 *
 * Requires env vars (or .env.local in project root):
 *   DO_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *   GITHUB_REPO (default: vaxman14/socal-receptionist),
 *   OPENAI_API_KEY, SMTP_HOST, SMTP_USER, SMTP_PASS
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });
const https = require('https');
const readline = require('readline');

const DO_TOKEN = process.env.DO_TOKEN;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'vaxman14/socal-receptionist';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname, path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload ? Buffer.byteLength(payload) : 0,
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function doRequest(method, path, body) {
  return request(method, 'api.digitalocean.com', path, {
    Authorization: `Bearer ${DO_TOKEN}`,
  }, body);
}

function twilioRequest(method, path, params) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const body = params ? new URLSearchParams(params).toString() : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method, hostname: 'api.twilio.com', path,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': body ? Buffer.byteLength(body) : 0,
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Prompt helper ─────────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function buyTwilioNumber(areaCode) {
  console.log(`\n📞 Searching for a local number in area code ${areaCode}...`);
  const search = await twilioRequest('GET',
    `/2010-04-01/Accounts/${TWILIO_SID}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&SmsEnabled=true&Limit=1`
  );
  if (!search.body.available_phone_numbers || !search.body.available_phone_numbers.length) {
    throw new Error(`No numbers available for area code ${areaCode}. Try a nearby area code.`);
  }
  const number = search.body.available_phone_numbers[0].phone_number;
  console.log(`   Found: ${number}`);

  const buy = await twilioRequest('POST',
    `/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers.json`,
    { PhoneNumber: number, FriendlyName: `SoCal Receptionist` }
  );
  if (buy.status !== 201) throw new Error(`Failed to buy number: ${JSON.stringify(buy.body)}`);
  console.log(`   ✅ Purchased ${number} (SID: ${buy.body.sid})`);
  return { number, sid: buy.body.sid };
}

async function setTwilioWebhook(numberSid, appUrl) {
  console.log(`\n🔗 Setting Twilio webhooks → ${appUrl}`);
  const res = await twilioRequest('POST',
    `/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers/${numberSid}.json`,
    {
      SmsUrl: `${appUrl}/sms`,
      SmsMethod: 'POST',
      VoiceUrl: `${appUrl}/voice`,
      VoiceMethod: 'POST',
    }
  );
  if (res.status !== 200) throw new Error(`Webhook update failed: ${JSON.stringify(res.body)}`);
  console.log(`   ✅ SMS webhook: ${appUrl}/sms`);
}

async function createDoApp(client) {
  console.log(`\n🚀 Creating DigitalOcean app for "${client.businessName}"...`);

  // Slug: lowercase alphanumeric + hyphens, max 32 chars
  const slug = client.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28);
  const appName = `socal-${slug}`;

  const spec = {
    name: appName,
    region: 'sfo',
    services: [{
      name: 'web',
      github: {
        repo: GITHUB_REPO,
        branch: 'master',
        deploy_on_push: true,
      },
      run_command: 'node server.js',
      http_port: 8080,
      instance_size_slug: 'apps-s-1vcpu-0.5gb',
      instance_count: 1,
      envs: [
        { key: 'NODE_ENV', value: 'production', scope: 'RUN_AND_BUILD_TIME' },
        { key: 'BUSINESS_NAME', value: client.businessName, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'BUSINESS_HOURS', value: client.hours, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'BUSINESS_SERVICES', value: client.services, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'CALENDLY_LINK', value: client.calendly, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'OWNER_EMAIL', value: client.ownerEmail, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'TWILIO_ACCOUNT_SID', value: TWILIO_SID, scope: 'RUN_AND_BUILD_TIME', type: 'SECRET' },
        { key: 'TWILIO_AUTH_TOKEN', value: TWILIO_TOKEN, scope: 'RUN_AND_BUILD_TIME', type: 'SECRET' },
        { key: 'TWILIO_PHONE_NUMBER', value: client.phoneNumber, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'OPENAI_API_KEY', value: OPENAI_KEY, scope: 'RUN_AND_BUILD_TIME', type: 'SECRET' },
        { key: 'OPENAI_MODEL', value: 'gpt-4o', scope: 'RUN_AND_BUILD_TIME' },
        { key: 'SMTP_HOST', value: SMTP_HOST, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'SMTP_USER', value: SMTP_USER, scope: 'RUN_AND_BUILD_TIME' },
        { key: 'SMTP_PASS', value: SMTP_PASS, scope: 'RUN_AND_BUILD_TIME', type: 'SECRET' },
      ],
    }],
  };

  const res = await doRequest('POST', '/v2/apps', { spec });
  if (res.status !== 201) throw new Error(`DO app creation failed: ${JSON.stringify(res.body)}`);

  const appId = res.body.app.id;
  const appUrl = `https://${res.body.app.default_ingress}`;
  console.log(`   ✅ App created: ${appName} (ID: ${appId})`);
  console.log(`   🌐 URL: ${appUrl}`);
  console.log(`   ⏳ First deploy takes ~3 min. DO will build from GitHub automatically.`);
  return { appId, appUrl, appName };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║   SoCal Receptionist — Client Provisioner ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const businessName  = await prompt(rl, 'Business name: ');
  const ownerEmail    = await prompt(rl, 'Owner email (for lead alerts): ');
  const hours         = await prompt(rl, 'Business hours (e.g. Mon-Fri 9am-6pm PST): ');
  const services      = await prompt(rl, 'Services offered (comma-separated): ');
  const calendly      = await prompt(rl, 'Calendly booking link: ');
  const areaCode      = await prompt(rl, 'Preferred area code for phone number (e.g. 951): ');
  rl.close();

  console.log('\n── Starting provisioning ──');

  try {
    // 1. Buy Twilio number
    const { number, sid: numberSid } = await buyTwilioNumber(areaCode.trim());

    // 2. Create DO app
    const client = { businessName, ownerEmail, hours, services, calendly, phoneNumber: number };
    const { appId, appUrl, appName } = await createDoApp(client);

    // 3. Wire Twilio webhooks (app URL is known even before deploy finishes)
    await setTwilioWebhook(numberSid, appUrl);

    // 4. Summary
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║              ✅ ALL DONE                   ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`\nBusiness:    ${businessName}`);
    console.log(`Phone:       ${number}`);
    console.log(`App URL:     ${appUrl}`);
    console.log(`DO App ID:   ${appId}`);
    console.log(`\n⏳ App will be live in ~3 minutes once DO finishes the first deploy.`);
    console.log(`📧 Lead alerts will go to: ${ownerEmail}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Wait ~3 min, then visit ${appUrl}/health to confirm it's up`);
    console.log(`  2. Text ${number} to test the opt-in flow`);
    console.log(`  3. Submit toll-free verification if using an 800/855/etc number`);
    console.log(`     (local 10DLC numbers like 951/760 work immediately)\n`);

  } catch (err) {
    console.error('\n❌ Provisioning failed:', err.message);
    process.exit(1);
  }
}

main();
