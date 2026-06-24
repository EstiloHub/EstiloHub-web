//firebase SDK
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth
} from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
} from
  "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
const firebaseConfig= {
  apikey: "AIzaSyAa3tscObg263CLdVyrUN7ZrB4LbO-1jgQ",
  authDomain: "estilo-hub.firebaseapp.com",
  projectId: "estilo-hub",
  storangeBucket: "estilo-hub.firebasestorange.app",
  messagingSenderId: "442111984808",
  appId: "1.442111984908:web:28aa9a2ca682c3174b3529"
};
const app= initializeApp(firebaseConfig);

const auth= getAuth(app);
const db= getFirestore(app);

export { auth, db };
