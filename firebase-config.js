// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyA6RiB-bqTR3on_KpIRARLm0W3SWeYWaz0",
  authDomain: "wenzuoweb.firebaseapp.com",
  projectId: "wenzuoweb",
  storageBucket: "wenzuoweb.appspot.com",
  messagingSenderId: "415514650847",
  appId: "1:415514650847:web:18d293683bfcbea4f9e16a",
  measurementId: "G-MDDZ10S396"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Firestore and Storage instances
export const db = getFirestore(app);
export const storage = getStorage(app);