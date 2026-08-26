const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey
    })
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido."
    });
  }

  try {
    getFirebaseAdmin();

    const auth = getAuth();
    const db = getFirestore();

    const {
      email,
      password,
      payoneer,
      codigo
    } = req.body || {};

    const emailLimpio = String(email || "").trim();
    const payoneerLimpio = String(payoneer || "").trim();
    const codigoLimpio = String(codigo || "").trim().toUpperCase();

    if (!emailLimpio) {
      return res.status(400).json({
        ok: false,
        error: "Ingrese un correo electrónico."
      });
    }

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: "Ingrese una contraseña."
      });
    }

    if (!payoneerLimpio) {
      return res.status(400).json({
        ok: false,
        error: "Ingrese su correo de Payoneer."
      });
    }

    if (!codigoLimpio) {
      return res.status(400).json({
        ok: false,
        error: "Ingrese el código de acceso."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "La contraseña debe tener al menos 6 caracteres."
      });
    }

    // Crear usuario en Firebase Authentication
    let usuario;

    try {
      usuario = await auth.createUser({
        email: emailLimpio,
        password: password
      });
    } catch (error) {
      if (error.code === "auth/email-already-exists") {
        return res.status(409).json({
          ok: false,
          error: "Ese correo electrónico ya está registrado."
        });
      }

      throw error;
    }

    const uid = usuario.uid;

    try {
      // Validar y reservar el código
      const codigoRef = db.collection("codigos").doc(codigoLimpio);

      await db.runTransaction(async (transaction) => {
        const codigoSnap = await transaction.get(codigoRef);

        if (!codigoSnap.exists) {
          throw new Error("CODIGO_NO_VALIDO");
        }

        const data = codigoSnap.data();

        if (data.estado !== "disponible") {
          throw new Error("CODIGO_NO_DISPONIBLE");
        }

        transaction.update(codigoRef, {
          estado: "usado",
          email: emailLimpio,
          usuario_id: uid,
          fecha_uso: FieldValue.serverTimestamp(),
          liberado: false,
          fecha_liberacion: null
        });
      });

      // Crear documento del usuario
      await db.collection("users").doc(uid).set({
        usuario_id: uid,
        email: emailLimpio,
        payoneer: payoneerLimpio,
        codigo_acceso: codigoLimpio,
        fechaRegistro: FieldValue.serverTimestamp(),
        admin: false,
        activo: true,
        fase: "Fase 1",
        pagina_real: false
      });

      // Crear estadísticas iniciales
      await db.collection("estadisticas_usuario").doc(uid).set({
        email: emailLimpio,
        usuario_id: uid,
        tareas_realizadas: 0,
        dias_trabajados: 0,
        minutos_acumulados: 0,
        ultima_fecha_trabajo: null
      });

      return res.status(200).json({
        ok: true
      });

    } catch (error) {
      // Si algo falla después de crear Auth,
      // eliminamos el usuario para no dejar una cuenta incompleta.
      try {
        await auth.deleteUser(uid);
      } catch (deleteError) {
      
      }

      if (error.message === "CODIGO_NO_VALIDO") {
        return res.status(400).json({
          ok: false,
          error: "El código de acceso no es válido."
        });
      }

      if (error.message === "CODIGO_NO_DISPONIBLE") {
        return res.status(400).json({
          ok: false,
          error: "El código de acceso ya no está disponible."
        });
      }

      throw error;
    }

  } catch (error) {

    return res.status(500).json({
      ok: false,
      error: "No se pudo crear la cuenta."
    });
  }
};
