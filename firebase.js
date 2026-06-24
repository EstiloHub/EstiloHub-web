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
  apikey: "AIzaSyAa3tscObg263CLdVyrUN7ZrB4LbO-1JgQ",
  authDomain: "estilo-hub.firebaseapp.com",
  projectId: "estilo-hub",
  storangeBucket: "estilo-hub.firebasestorange.app",
  messagingSenderId: "442111984908",
  appId: "1.442111984908:web:28aa9a2ca682c3174b3529"
};

<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  const firebaseConfig = {
    apiKey: "AIzaSyAa3tscObg263CLdVyrUN7ZrB4LbO-1JgQ",
    authDomain: "estilo-hub.firebaseapp.com",
    projectId: "estilo-hub",
    storageBucket: "estilo-hub.firebasestorage.app",
    messagingSenderId: "442111984908",
    appId: "1:442111984908:web:28aa9a2ca682c3174b3529"
  };



  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
</script>
const app= initializeApp(firebaseConfig);

const auth= getAuth(app);
const db= getFirestore(app);

export { auth, db };
