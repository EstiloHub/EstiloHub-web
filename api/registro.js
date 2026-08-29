const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

function getFirebaseAdmin() {
  if (getApps().length) {
    return getApps()[0];
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY
        .replace(/^"|"$/g, "")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .trim()
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
    const codigoLimpio = String(codigo || "").trim();

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

// ==========================================
// VALIDAR EL CÓDIGO ANTES DE CREAR LA CUENTA
// ==========================================

    const todosLosCodigos = await db
  .collection("codigos_acceso")
  .get();

let codigoEncontrado = null;

for (const documento of todosLosCodigos.docs) {
  const datos = documento.data();

  if (String(datos.codigo || "").trim() === codigoLimpio) {
    codigoEncontrado = documento;
    break;
  }
}

if (!codigoEncontrado) {
  return res.status(400).json({
    ok: false,
    error: "El código de acceso no es válido."
  });
}

  const codigoSnap = codigoEncontrado;
const codigoData = codigoSnap.data();

// ==========================================
// CREAR USUARIO EN FIREBASE AUTHENTICATION
// ==========================================

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

// ==========================================
// RESERVAR EL CÓDIGO
// ==========================================

      await db.runTransaction(async (transaction) => {

        const codigoActual = await transaction.get(codigoSnap.ref);

        if (!codigoActual.exists) {
          throw new Error("CODIGO_NO_VALIDO");
          
}

        const dataActual = codigoActual.data();

        if (dataActual.estado !== "disponible") {
          throw new Error("CODIGO_NO_VALIDO");
          
}

        transaction.update(codigoSnap.ref, {
          estado: "usado",
          email: emailLimpio,
          usuario_id: uid,
          fecha_uso: FieldValue.serverTimestamp(),
          liberado: false,
          fecha_liberacion: null
          
});

});

// ==========================================
// CREAR DOCUMENTO DEL USUARIO
// ==========================================

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

// ==========================================
// CREAR ESTADÍSTICAS INICIALES
// ==========================================

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

      // Eliminar la cuenta si ocurrió un error
      // después de crearla.

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

      throw error;
      
  }

  } catch (error) {

    return res.status(500).json({
      ok: false,
      error: "No se pudo crear la cuenta."
    
});

}

};
