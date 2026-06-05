require('dotenv').config();

const comingSoon = process.env.COMING_SOON === 'true';

function required(name) {
  const value = process.env[name];
  if (!comingSoon && (!value || !value.trim())) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ? value.trim() : '';
}

function optional(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

const config = {
  port: parseInt(process.env.PORT || '8080', 10),

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    phoneNumber: required('TWILIO_PHONE_NUMBER'),
    salesNumber: optional('TWILIO_SALES_NUMBER', ''),
    // Set TWILIO_VALIDATE_SIGNATURE=false only for local testing.
    validateSignature: optional('TWILIO_VALIDATE_SIGNATURE', 'true') !== 'false',
  },

  calendly: {
    apiToken: optional('CALENDLY_API_TOKEN', ''),
  },

  gcal: {
    clientId: optional('GOOGLE_CLIENT_ID', ''),
    clientSecret: optional('GOOGLE_CLIENT_SECRET', ''),
    refreshToken: optional('GOOGLE_REFRESH_TOKEN', ''),
    refreshTokenInfo: optional('GOOGLE_REFRESH_TOKEN_INFO', ''),
    refreshTokenSupport: optional('GOOGLE_REFRESH_TOKEN_SUPPORT', ''),
    serviceAccountKey: optional('GOOGLE_SERVICE_ACCOUNT_KEY', ''),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-4o'),
  },

  groq: {
    apiKey: optional('GROQ_API_KEY', ''),
    model: optional('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    baseURL: 'https://api.groq.com/openai/v1',
  },

  business: {
    name: required('BUSINESS_NAME'),
    hours: required('BUSINESS_HOURS'),
    services: required('BUSINESS_SERVICES'),
    calendlyLink: required('CALENDLY_LINK'),
    ownerEmail: required('OWNER_EMAIL'),
  },

  email: {
    host: required('SMTP_HOST'),
    port: parseInt(optional('SMTP_PORT', '587'), 10),
    user: required('SMTP_USER'),
    pass: required('SMTP_PASS'),
    from: optional('SMTP_FROM', ''),
  },

  analytics: {
    gtmId: optional('GTM_ID', ''),
    gaId: optional('GA_ID', ''),
    fbPixelId: optional('FB_PIXEL_ID', ''),
  },

  internalSecret: optional('INTERNAL_SECRET', ''),
};

if (!config.email.from) {
  config.email.from = `"${config.business.name} Receptionist" <${config.email.user}>`;
}

module.exports = config;
