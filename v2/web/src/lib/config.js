// Build-time feature flags, read from Vite env.
//
// VITE_ vars are baked into the bundle at build time — flipping a flag means a
// rebuild + redeploy, which is fine for launch gates.

// Voice-first launch gate. SMS / Conversations surfaces stay hidden ("coming
// soon") until A2P 10DLC carrier review clears. Defaults to false.
export const SMS_ENABLED = import.meta.env.VITE_SMS_ENABLED === 'true';
