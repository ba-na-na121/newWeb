// Firebase setup shared by password.html and lifestyle.html.
// This config is public by design; what protects the data are the rules in
// firestore.rules and storage.rules, plus the two login accounts below.

// All Firebase modules must come from the same version.
export const FB_SDK = "https://www.gstatic.com/firebasejs/13.0.0";

const { initializeApp } = await import(`${FB_SDK}/firebase-app.js`);
const { getAuth } = await import(`${FB_SDK}/firebase-auth.js`);
const { getFirestore } = await import(`${FB_SDK}/firebase-firestore.js`);
const { getStorage } = await import(`${FB_SDK}/firebase-storage.js`);

const firebaseConfig = {
  apiKey: "AIzaSyA6RiB-bqTR3on_KpIRARLm0W3SWeYWaz0",
  authDomain: "wenzuoweb.firebaseapp.com",
  projectId: "wenzuoweb",
  storageBucket: "wenzuoweb.appspot.com",
  messagingSenderId: "415514650847",
  appId: "1:415514650847:web:18d293683bfcbea4f9e16a",
  measurementId: "G-MDDZ10S396"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
// The SDK normally retries a broken upload silently for up to 10 minutes, which looks like "stuck at 0%".
// Give up after 1 minute instead; lifestyle.js then retries the file itself and shows what happened.
storage.maxUploadRetryTime = 60 * 1000;

// Login accounts (created in Firebase Console → Authentication → Users).
// These addresses never receive email; they are just usernames.
//  - FRIENDS_EMAIL: shared account. Its password is the one you give to friends. Can only view.
//  - OWNER_EMAIL:   your own account, with a different password. Can add, edit and delete.
// If you change OWNER_EMAIL, change it in firestore.rules and storage.rules too.
export const FRIENDS_EMAIL = "friends@wenzuoweb.firebaseapp.com";
export const OWNER_EMAIL = "owner@wenzuoweb.firebaseapp.com";

export const isOwner = (user) => !!user && user.email === OWNER_EMAIL;

// App Check (reCAPTCHA Enterprise) proves that AI requests really come from this website,
// so nobody else can spend the project's Gemini quota with the public config above.
// Paste the reCAPTCHA Enterprise key ID here. It is public by design and safe to commit.
export const APP_CHECK_SITE_KEY = "6LcnHBEuAAAAAKTn7gpRcPgddl1Ujd1dhxA5g7QC";

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
let aiApp = null;

// The AI gets its own Firebase connection with App Check (reCAPTCHA) attached. Keeping it separate means
// a slow or blocked reCAPTCHA on a phone can never hold up photo uploads or loading the archive.
// Started only when the AI is first used, so other pages never load reCAPTCHA.
export async function getAiApp() {
  if (aiApp) return aiApp;
  if (!APP_CHECK_SITE_KEY) throw new Error('App Check is not set up: APP_CHECK_SITE_KEY in firebase-config.js is empty.');
  const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(`${FB_SDK}/firebase-app-check.js`);
  if (aiApp) return aiApp; // another call finished first
  // On your own computer (npx serve) reCAPTCHA can't vouch for "localhost". Instead the SDK prints a
  // debug token in the browser console (F12); add it once in Firebase → App Check → Manage debug tokens.
  if (isLocal) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const a = initializeApp(firebaseConfig, 'ai');
  initializeAppCheck(a, {
    provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
  return (aiApp = a);
}
