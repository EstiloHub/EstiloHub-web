const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

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
      privateKey
    })
  });
}

const app = getFirebaseAdmin();
const db = getFirestore(app);
const auth = getAuth(app);

const ACTIVITY_WINDOW_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 10000;
const DURACION_REALIZACION_MS =
  7 * 24 * 60 * 60 * 1000;

function respuesta(res, status, datos) {
  return res.status(status).json(datos);
}

function ahora() {
  return Timestamp.now();
}

function ahoraMs() {
  return Date.now();
}

function obtenerFechaArgentina() {
  const partes = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());

  const valores = {};

  for (const parte of partes) {
    if (parte.type !== "literal") {
      valores[parte.type] = parte.value;
    }
  }

  return `${valores.year}-${valores.month}-${valores.day}`;
}

function timestampMs(valor) {
  if (!valor) return null;

  if (typeof valor.toMillis === "function") {
    return valor.toMillis();
  }

  if (valor instanceof Date) {
    return valor.getTime();
  }

  if (typeof valor === "number") {
    return valor;
  }

  return null;
}

function minutosCompletos(ms) {
  return Math.floor(Math.max(0, ms) / 60000);
}

function obtenerTiempoRequeridoMs(tarea) {
  const minutos = Number(tarea?.tiempo_requerido);

  if (!Number.isFinite(minutos) || minutos <= 0) {
    throw new Error("TIEMPO_REQUERIDO_INVALIDO");
  }

  return Math.floor(minutos * 60000);
}

function normalizarFase(valor) {
  const fase = String(valor ?? "")
    .trim()
    .toLowerCase()
    .replace(/^fase\s*/, "");

  if (!/^\d+$/.test(fase)) {
    return null;
  }

  return Number(fase);
}

function faseCoincide(usuario, tarea) {
  if (!usuario || !tarea) return false;

  const faseTarea = normalizarFase(tarea.fase);

  if (faseTarea === null) {
    return false;
  }

  if (
    usuario.fase === undefined ||
    usuario.fase === null
  ) {
    return faseTarea === 1;
  }

  const faseUsuario = normalizarFase(usuario.fase);

  return (
    faseUsuario !== null &&
    faseUsuario === faseTarea
  );
}

async function verificarToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const token = authorization
    .substring(7)
    .trim();

  if (!token) {
    throw new Error("NO_AUTORIZADO");
  }

  try {
    const decodedToken =
      await auth.verifyIdToken(token);

    if (!decodedToken?.uid) {
      throw new Error("NO_AUTORIZADO");
    }

    return decodedToken;
  } catch (error) {
    const erroresTokenInvalidos = new Set([
      "auth/argument-error",
      "auth/id-token-expired",
      "auth/id-token-revoked",
      "auth/invalid-id-token",
      "auth/invalid-credential"
    ]);

    if (
      erroresTokenInvalidos.has(error?.code) ||
      error?.message === "NO_AUTORIZADO"
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    throw error;
  }
}

async function obtenerUsuario(uid) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error("USUARIO_NO_ENCONTRADO");
  }

  const usuario = snap.data();

  if (usuario.activo !== true) {
    throw new Error("USUARIO_INACTIVO");
  }

  return {
    ...usuario,
    ref
  };
}

async function obtenerTarea(tareaId) {
  if (
    typeof tareaId !== "string" ||
    !tareaId.trim() ||
    tareaId.includes("/")
  ) {
    throw new Error("TAREA_ID_INVALIDO");
  }

  const ref = db
    .collection("tareas")
    .doc(tareaId);

  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error("TAREA_NO_ENCONTRADA");
  }

  return {
    ...snap.data(),
    ref
  };
}

function tareaRetirada(tarea) {
  return tarea?.retirada === true;
}

function tareaDisponibleParaNuevaRealizacion(tarea) {
  return (
    tarea?.activa === true &&
    !tareaRetirada(tarea)
  );
}

function tareaPublica(tarea) {
  const tiempoRequerido =
    Number(tarea?.tiempo_requerido);

  return {
    id: tarea.ref.id,
    titulo: tarea.titulo || "",
    descripcion: tarea.descripcion || "",
    categoria: tarea.categoria || "",
    fase: tarea.fase ?? null,
    link_url: tarea.link_url || "",
    tiempo_requerido:
      Number.isFinite(tiempoRequerido) &&
      tiempoRequerido > 0
        ? tiempoRequerido
        : 0
  };
}

function realizacionPublica(realizacion) {
  if (!realizacion) return null;

  const tiempoActivo =
    Number(realizacion.tiempo_activo_valido);

  return {
    fecha_inicio:
      realizacion.fecha_inicio || null,

    tiempo_activo_valido:
      Number.isFinite(tiempoActivo) &&
      tiempoActivo > 0
        ? tiempoActivo
        : 0
  };
}

function sesionPublica(
  sesion,
  tiempoCalculado = null
) {
  if (!sesion) return null;

  const tiempoActivo = Number(
    tiempoCalculado?.tiempo_activo_valido ??
    sesion.tiempo_activo_valido
  );

  const tiempoRequerido = Number(
    sesion.tiempo_requerido_ms
  );

  const tiempoActivoSeguro =
    Number.isFinite(tiempoActivo) &&
    tiempoActivo > 0
      ? tiempoActivo
      : 0;

  const tiempoRequeridoSeguro =
    Number.isFinite(tiempoRequerido) &&
    tiempoRequerido > 0
      ? tiempoRequerido
      : 0;

  return {
    activa: sesion.activa === true,
    tiempo_activo_valido: tiempoActivoSeguro,
    tiempo_requerido_alcanzado:
      tiempoRequeridoSeguro > 0 &&
      tiempoActivoSeguro >= tiempoRequeridoSeguro
  };
}

function obtenerBloqueoUsuarioRef(uid) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  return db
    .collection("bloqueos_tareas")
    .doc(uid);
}

function bloqueoCoincideConSesion(
  bloqueo,
  sesion
) {
  return Boolean(
    bloqueo &&
    sesion &&
    bloqueo.usuario_id === sesion.usuario_id &&
    bloqueo.sesion_id === sesion.ref.id &&
    bloqueo.realizacion_id === sesion.realizacion_id &&
    bloqueo.tarea_id === sesion.tarea_id
  );
}

function liberarBloqueoSesion(
  tx,
  bloqueoRef,
  ahoraTimestamp
) {
  tx.update(bloqueoRef, {
    sesion_id: null,
    realizacion_id: null,
    tarea_id: null,
    actividad_valida_hasta: null,
    actualizado_en: ahoraTimestamp
  });
}

function obtenerBloqueoRealizacionRef(
  uid,
  tareaId
) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/") ||
    typeof tareaId !== "string" ||
    !tareaId.trim() ||
    tareaId.includes("/")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  return obtenerBloqueoUsuarioRef(uid)
    .collection("realizaciones")
    .doc(tareaId);
}

function obtenerDiaTrabajadoRef(
  uid,
  fechaArgentina
) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/") ||
    typeof fechaArgentina !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(fechaArgentina)
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  return db
    .collection("dias_trabajados_usuario")
    .doc(uid)
    .collection("fechas")
    .doc(fechaArgentina);
}

async function obtenerRealizacionUsuario(
  tareaId,
  uid
) {
  if (
    typeof tareaId !== "string" ||
    !tareaId.trim() ||
    tareaId.includes("/") ||
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const snap = await db
    .collection("realizaciones_tareas")
    .where("tarea_id", "==", tareaId)
    .where("usuario_id", "==", uid)
    .where("estado", "==", "pendiente")
    .get();

  if (snap.empty) {
    return null;
  }

  if (snap.size > 1) {
    throw new Error(
      "REALIZACIONES_DUPLICADAS"
    );
  }

  const doc = snap.docs[0];

  return {
    ...doc.data(),
    ref: doc.ref
  };
}

async function cerrarRealizacionPorCaducidad(
  ref,
  motivo
) {
  const ahoraTimestamp = ahora();

  await db.runTransaction(async (tx) => {
    // Primero se leen todos los documentos.
    const actualSnap =
      await tx.get(ref);

    if (!actualSnap.exists) return;

    const actual = actualSnap.data();

    if (actual.estado !== "pendiente") {
      return;
    }
    
    const vencimientoMs =
      timestampMs(actual.fecha_vencimiento);

    if (!Number.isFinite(vencimientoMs)) {
  throw new Error("FECHA_VENCIMIENTO_INVALIDA");
}

if (
  vencimientoMs > ahoraTimestamp.toMillis()
) {
  return;
}
    
    const sesionesQuery = db
      .collection("sesiones_tareas")
      .where("realizacion_id", "==", ref.id)
      .where("activa", "==", true);

    const sesionesSnap =
      await tx.get(sesionesQuery);

    const bloqueoRef =
      obtenerBloqueoUsuarioRef(
        actual.usuario_id
      );

    const bloqueoSnap =
      await tx.get(bloqueoRef);

    if (sesionesSnap.size > 1) {
      throw new Error(
        "SESIONES_ACTIVAS_DUPLICADAS"
      );
    }

    const sesiones = sesionesSnap.docs.map(
      (doc) => ({
        ref: doc.ref,
        ...doc.data()
      })
    );

    let tiempoActivo = Math.max(
      0,
      Number(actual.tiempo_activo_valido) || 0
    );

    let tiempoAdicional = Math.max(
      0,
      Number(actual.tiempo_adicional) || 0
    );

    let valoresTiempo = null;

    if (sesiones.length === 1) {
      const sesion = sesiones[0];

      if (
        sesion.usuario_id !== actual.usuario_id ||
        sesion.realizacion_id !== ref.id ||
        sesion.tarea_id !== actual.tarea_id
      ) {
        throw new Error(
          "RELACION_SESION_INVALIDA"
        );
      }

      const tareaSnapshot = {
        tiempo_requerido:
          actual.tiempo_requerido_minutos ??
          sesion.tiempo_requerido_minutos
      };

      valoresTiempo =
        calcularNuevoTiempo(
          sesion,
          {
            ...actual,
            ref
          },
          tareaSnapshot,
          ahoraTimestamp.toMillis()
        );

      tiempoActivo =
        valoresTiempo.tiempo_activo_valido;

      tiempoAdicional =
        valoresTiempo.tiempo_adicional;
    }

    const historialRef = db
      .collection("historial_realizaciones")
      .doc(ref.id);

 // Todas las lecturas terminaron.
 // A partir de aquí se realizan las escrituras.

for (const sesion of sesiones) {
tx.update(sesion.ref, {
activa: false,

    tiempo_activo_valido:
      tiempoActivo,

    tiempo_adicional:
      tiempoAdicional,

    fecha_finalizacion:
      ahoraTimestamp,

    actividad_valida_hasta:
      ahoraTimestamp,

    ultimo_punto_conteo:
      ahoraTimestamp
  });

  // Liberar solo el bloqueo correspondiente a esta sesión.
  if (
  bloqueoSnap.exists &&
  bloqueoCoincideConSesion(
    bloqueoSnap.data(),
    sesion
  )
) {
  liberarBloqueoSesion(
    tx,
    bloqueoRef,
    ahoraTimestamp
  );
    }
}

// Si no hay sesión, liberar el bloqueo solo si pertenece a esta realización.
if (
  sesiones.length === 0 &&
  bloqueoSnap.exists &&
  bloqueoSnap.data().usuario_id === actual.usuario_id &&
  bloqueoSnap.data().realizacion_id === ref.id &&
  bloqueoSnap.data().tarea_id === actual.tarea_id
) {
  tx.update(bloqueoRef, {
    sesion_id: null,
    realizacion_id: null,
    tarea_id: null,
    actividad_valida_hasta: null,
    actualizado_en: ahoraTimestamp
  });
}

// Cerrar siempre la realización vencida y guardar su historial.
tx.update(ref, {
  estado: "vencida",

  fecha_cierre:
    ahoraTimestamp,

  motivo_cierre: motivo,

  tiempo_activo_valido:
    tiempoActivo,

  tiempo_adicional:
    tiempoAdicional
});

tx.set(historialRef, {
  tarea_id: actual.tarea_id,

  realizacion_id: ref.id,

  usuario_id: actual.usuario_id,

  email: actual.email || null,

  titulo_tarea:
    actual.titulo_tarea || null,

  descripcion_tarea:
    actual.descripcion_tarea || null,

  categoria_tarea:
    actual.categoria_tarea || null,

  link_url_tarea:
    actual.link_url_tarea || null,

  fecha_inicio:
    actual.fecha_inicio || null,

  fecha_vencimiento:
    actual.fecha_vencimiento || null,

  fecha_cierre:
    ahoraTimestamp,

  motivo_cierre: motivo,

  estado_final: "vencida",

  tiempo_requerido_minutos:
  actual.tiempo_requerido_minutos ?? null,

fase_tarea:
  actual.fase_tarea ?? null,

repetible:
  typeof actual.repetible === "boolean"
    ? actual.repetible
    : null,

  tiempo_requerido_ms:
    actual.tiempo_requerido_ms || null,

  tiempo_activo_valido:
    tiempoActivo,

  tiempo_adicional:
    tiempoAdicional,

  tiempo_total:
    tiempoActivo + tiempoAdicional
});

  }); // Cierra db.runTransaction()

} // Cierra cerrarRealizacionPorCaducidad()

async function obtenerOCrearRealizacion(
  tarea,
  usuario,
  uid
) {
  let realizacion =
    await obtenerRealizacionUsuario(
      tarea.ref.id,
      uid
    );

  if (realizacion) {
    const vencimientoMs =
      timestampMs(
        realizacion.fecha_vencimiento
      );

    if (!Number.isFinite(vencimientoMs)) {
      throw new Error("FECHA_VENCIMIENTO_INVALIDA");
    }

    if (vencimientoMs <= ahoraMs()) {
      await cerrarRealizacionPorCaducidad(
        realizacion.ref,
        "vencimiento_7_dias"
      );

      realizacion = null;
    }
  }

  if (realizacion) {
    return realizacion;
  }

  if (
    !tareaDisponibleParaNuevaRealizacion(tarea)
  ) {
    throw new Error("TAREA_NO_DISPONIBLE");
  }

  if (!faseCoincide(usuario, tarea)) {
    throw new Error("TAREA_NO_CORRESPONDE");
  }

  const bloqueoRef =
    obtenerBloqueoRealizacionRef(
      uid,
      tarea.ref.id
    );

  const nuevaRef = db
    .collection("realizaciones_tareas")
    .doc();

  let resultado = null;

  await db.runTransaction(async (tx) => {
    // Este documento determinista serializa
    // las creaciones simultáneas de esta tarea
    // para el mismo usuario.
    const bloqueoSnap =
      await tx.get(bloqueoRef);

    const tareaSnap =
      await tx.get(tarea.ref);

    if (!tareaSnap.exists) {
      throw new Error("TAREA_NO_DISPONIBLE");
    }

    const tareaActual = {
      ...tareaSnap.data(),
      ref: tarea.ref
    };

    if (
      !tareaDisponibleParaNuevaRealizacion(
        tareaActual
      )
    ) {
      throw new Error("TAREA_NO_DISPONIBLE");
    }

    if (!faseCoincide(usuario, tareaActual)) {
      throw new Error("TAREA_NO_CORRESPONDE");
    }

    const realizacionesQuery = db
      .collection("realizaciones_tareas")
      .where("tarea_id", "==", tarea.ref.id)
      .where("usuario_id", "==", uid);

    const realizacionesSnap =
      await tx.get(realizacionesQuery);

    const pendientes =
      realizacionesSnap.docs.filter(
        (doc) => doc.data().estado === "pendiente"
      );

    if (pendientes.length > 1) {
      throw new Error(
        "REALIZACIONES_DUPLICADAS"
      );
    }

    if (pendientes.length === 1) {
      const doc = pendientes[0];
      const datos = doc.data();

      const vencimientoMs =
        timestampMs(datos.fecha_vencimiento);

      if (!Number.isFinite(vencimientoMs)) {
  throw new Error("FECHA_VENCIMIENTO_INVALIDA");
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error("REALIZACION_VENCIDA");
}
      resultado = {
        ...datos,
        ref: doc.ref
      };

      return;
    }

    const anteriores =
      realizacionesSnap.docs
        .map((doc) => ({
          ...doc.data(),
          ref: doc.ref
        }))
        .sort((a, b) => {
          return (
            (timestampMs(b.fecha_inicio) || 0) -
            (timestampMs(a.fecha_inicio) || 0)
          );
        });

    const primeraRealizacion =
      anteriores.length > 0
        ? anteriores[anteriores.length - 1]
        : null;

    const repetible =
      primeraRealizacion &&
      typeof primeraRealizacion.repetible === "boolean"
        ? primeraRealizacion.repetible
        : tareaActual.repetible === true;

    if (anteriores.length > 0) {
      if (!repetible) {
        throw new Error("TAREA_YA_REALIZADA");
      }

      if (anteriores[0].estado !== "completada") {
        throw new Error(
          "REALIZACION_ANTERIOR_NO_COMPLETADA"
        );
      }
    }

    const tiempoRequeridoMs =
      obtenerTiempoRequeridoMs(tareaActual);

    const fechaInicio = ahora();

    const fechaVencimiento =
      Timestamp.fromMillis(
        fechaInicio.toMillis() +
          DURACION_REALIZACION_MS
      );

    const datos = {
      tarea_id: tareaActual.ref.id,
      usuario_id: uid,
      email: usuario.email || null,

      titulo_tarea:
        tareaActual.titulo || null,

      descripcion_tarea:
        tareaActual.descripcion || null,

      categoria_tarea:
        tareaActual.categoria || null,

      link_url_tarea:
        tareaActual.link_url || null,

      fecha_inicio: fechaInicio,
      fecha_vencimiento: fechaVencimiento,

      estado: "pendiente",

      tiempo_requerido_ms:
        tiempoRequeridoMs,

      tiempo_requerido_minutos:
        Number(tareaActual.tiempo_requerido),

      repetible,

      fase_tarea:
        tareaActual.fase ?? null,

      tiempo_activo_valido: 0,
      tiempo_adicional: 0,

      cantidad_pausas: 0,
      cantidad_reanudaciones: 0,
      cantidad_heartbeat: 0,
      cantidad_actividades: 0
    };

    tx.create(nuevaRef, datos);

    // Se actualiza el documento determinista dentro
    // de la misma transacción que crea la realización.
    tx.set(bloqueoRef, {
      ...(bloqueoSnap.exists
        ? bloqueoSnap.data()
        : {}),

      usuario_id: uid,
      tarea_id: tareaActual.ref.id,
      ultima_realizacion_id: nuevaRef.id,
      ultima_creacion_realizacion: fechaInicio
    });

    resultado = {
      ...datos,
      ref: nuevaRef
    };
  });

  return resultado;
}

async function obtenerSesionActivaUsuario(uid) {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    uid.includes("/")
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const snap = await db
    .collection("sesiones_tareas")
    .where("usuario_id", "==", uid)
    .where("activa", "==", true)
    .get();

  if (snap.empty) {
    return null;
  }

  const sesionesValidas = [];

  for (const doc of snap.docs) {
    const sesion = {
      ...doc.data(),
      ref: doc.ref
    };

    const actividadHasta = timestampMs(
      sesion.actividad_valida_hasta
    );

    if (
      actividadHasta &&
      actividadHasta > ahoraMs()
    ) {
      sesionesValidas.push(sesion);
    } else {
      await cerrarSesionPorInactividad(
        sesion
      );
    }
  }

  if (sesionesValidas.length > 1) {
    throw new Error(
      "SESIONES_ACTIVAS_DUPLICADAS"
    );
  }

  return sesionesValidas[0] || null;
}

function calcularTiempoHastaAhora(
  sesion,
  realizacion,
  ahoraActualMs = ahoraMs()
) {
  if (!sesion || sesion.activa !== true) {
    return 0;
  }

  const ultimoPunto =
    timestampMs(
      sesion.ultimo_punto_conteo
    );

  const actividadHasta =
    timestampMs(
      sesion.actividad_valida_hasta
    );

  const vencimientoMs =
    timestampMs(
      realizacion?.fecha_vencimiento
    );

  if (
    !Number.isFinite(ultimoPunto) ||
    !Number.isFinite(actividadHasta) ||
    !Number.isFinite(vencimientoMs)
  ) {
    throw new Error(
      "FECHA_VENCIMIENTO_INVALIDA"
    );
  }

  const limite = Math.min(
    ahoraActualMs,
    actividadHasta,
    vencimientoMs
  );

  if (limite <= ultimoPunto) {
    return 0;
  }

  return limite - ultimoPunto;
 }

function calcularNuevoTiempo(
  sesion,
  realizacion,
  tarea,
  ahoraActualMs = ahoraMs()
) {
  // Prioridad: snapshot de la realización.
  // Así los cambios posteriores de la tarea no alteran
  // el tiempo requerido de una realización ya iniciada.
  let requeridoMs = Number(
    realizacion?.tiempo_requerido_ms
  );

  if (
    !Number.isFinite(requeridoMs) ||
    requeridoMs <= 0
  ) {
    requeridoMs = Number(
      sesion?.tiempo_requerido_ms
    );
  }

  if (
    !Number.isFinite(requeridoMs) ||
    requeridoMs <= 0
  ) {
    const minutosGuardados =
      Number(
        realizacion?.tiempo_requerido_minutos
      ) ||
      Number(
        sesion?.tiempo_requerido_minutos
      );

    if (
      Number.isFinite(minutosGuardados) &&
      minutosGuardados > 0
    ) {
      requeridoMs =
        minutosGuardados * 60 * 1000;
    }
  }

  // Compatibilidad con realizaciones antiguas
  // que todavía no tienen el tiempo guardado.
  if (
    !Number.isFinite(requeridoMs) ||
    requeridoMs <= 0
  ) {
    requeridoMs =
      obtenerTiempoRequeridoMs(tarea);
  }

  const activoActual = Math.max(
    0,
    Number(
      realizacion?.tiempo_activo_valido
    ) || 0
  );

  const adicionalActual = Math.max(
    0,
    Number(
      realizacion?.tiempo_adicional
    ) || 0
  );

  const pendiente =
    calcularTiempoHastaAhora(
      sesion,
      realizacion,
      ahoraActualMs
    );

  const faltanteRequerido =
    Math.max(
      0,
      requeridoMs - activoActual
    );

  const paraRequerido =
    Math.min(
      pendiente,
      faltanteRequerido
    );

  const restante =
    Math.max(
      0,
      pendiente - paraRequerido
    );

  return {
    requerido_ms: requeridoMs,

    tiempo_activo_valido:
      activoActual + paraRequerido,

    tiempo_adicional:
      adicionalActual + restante
  };
}

function registrarTiempoSesion(
  tx,
  sesion,
  realizacion,
  valores,
  ahoraTimestamp
) {
  tx.update(sesion.ref, {
    tiempo_activo_valido:
      valores.tiempo_activo_valido,

    tiempo_adicional:
      valores.tiempo_adicional,

    ultimo_punto_conteo:
      ahoraTimestamp
  });

  tx.update(realizacion.ref, {
    tiempo_activo_valido:
      valores.tiempo_activo_valido,

    tiempo_adicional:
      valores.tiempo_adicional
  });
}

async function cerrarSesionPorInactividad(sesion) {
  if (
    !sesion?.ref ||
    typeof sesion.realizacion_id !== "string" ||
    !sesion.realizacion_id ||
    typeof sesion.usuario_id !== "string" ||
    !sesion.usuario_id
  ) {
    return;
  }

  const realizacionRef =
    db.collection("realizaciones_tareas")
      .doc(sesion.realizacion_id);

  const bloqueoRef =
    obtenerBloqueoUsuarioRef(
      sesion.usuario_id
    );

  await db.runTransaction(async (tx) => {
    // Primero se leen todos los documentos.
    const sesionSnap =
      await tx.get(sesion.ref);

    if (!sesionSnap.exists) {
      return;
    }

    const realizacionSnap =
      await tx.get(realizacionRef);

    const bloqueoSnap =
      await tx.get(bloqueoRef);

    const sesionActual = {
      ref: sesion.ref,
      ...sesionSnap.data()
    };

    if (sesionActual.activa !== true) {
      return;
    }

    if (
      sesionActual.usuario_id !==
      sesion.usuario_id
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    const ahoraTimestamp = ahora();
    const ahoraActualMs =
      ahoraTimestamp.toMillis();

    // Revalidar dentro de la transacción.
    // Si otra solicitud renovó la actividad,
    // no se debe cerrar esta sesión.
    const actividadHasta =
      timestampMs(
        sesionActual.actividad_valida_hasta
      );

    if (
      actividadHasta &&
      actividadHasta > ahoraActualMs
    ) {
      return;
    }

    const bloqueo =
      bloqueoSnap.exists
        ? bloqueoSnap.data()
        : null;

    // Si la realización ya no existe, cerrar
    // la sesión sin intentar actualizarla.
    if (!realizacionSnap.exists) {
      tx.update(sesion.ref, {
        activa: false,
        fecha_finalizacion: ahoraTimestamp,
        actividad_valida_hasta: ahoraTimestamp,
        ultimo_punto_conteo: ahoraTimestamp
      });

      // Liberar únicamente el bloqueo de esta sesión.
      if (
        bloqueo &&
        bloqueoCoincideConSesion(
          bloqueo,
          sesionActual
      )
      ) {
        tx.update(bloqueoRef, {
          sesion_id: null,
          realizacion_id: null,
          tarea_id: null,
          actividad_valida_hasta: null,
          actualizado_en: ahoraTimestamp
        });
      }

      return;
    }

    const realizacionActual = {
      ref: realizacionRef,
      ...realizacionSnap.data()
    };

    const relacionValida =
      sesionActual.realizacion_id ===
        realizacionRef.id &&
      sesionActual.usuario_id ===
        realizacionActual.usuario_id &&
      sesionActual.tarea_id ===
        realizacionActual.tarea_id;

    if (!relacionValida) {
      throw new Error(
        "RELACION_SESION_INVALIDA"
      );
    }

    // Si la realización ya no está pendiente,
    // cerrar sin acumular tiempo adicional.
    if (
      realizacionActual.estado !== "pendiente"
    ) {
      tx.update(sesion.ref, {
        activa: false,
        fecha_finalizacion: ahoraTimestamp,
        actividad_valida_hasta: ahoraTimestamp,
        ultimo_punto_conteo: ahoraTimestamp
      });

      if (
        bloqueo &&
        bloqueoCoincideConSesion(
          bloqueo,
          sesionActual
      )
      ) {
        tx.update(bloqueoRef, {
          sesion_id: null,
          realizacion_id: null,
          tarea_id: null,
          actividad_valida_hasta: null,
          actualizado_en: ahoraTimestamp
        });
      }

      return;
    }

    const tareaSnapshot = {
      tiempo_requerido:
        realizacionActual.tiempo_requerido_minutos ??
        sesionActual.tiempo_requerido_minutos
    };

    const valores =
      calcularNuevoTiempo(
        sesionActual,
        realizacionActual,
        tareaSnapshot,
        ahoraActualMs
      );

    tx.update(sesion.ref, {
      activa: false,

      tiempo_activo_valido:
        valores.tiempo_activo_valido,

      tiempo_adicional:
        valores.tiempo_adicional,

      fecha_finalizacion:
        ahoraTimestamp,

      ultimo_punto_conteo:
        ahoraTimestamp,

      actividad_valida_hasta:
        ahoraTimestamp
    });

    tx.update(realizacionRef, {
      tiempo_activo_valido:
        valores.tiempo_activo_valido,

      tiempo_adicional:
        valores.tiempo_adicional
    });

    // No liberar un bloqueo que ya pertenezca
    // a una sesión posterior.
    if (
      bloqueo &&
      bloqueoCoincideConSesion(
        bloqueo,
        sesionActual
    )
    ) {
liberarBloqueoSesion(
  tx,
  bloqueoRef,
  ahoraTimestamp
);
}
});
}

async function obtenerSesionActual(realizacionId) {
  if (
    typeof realizacionId !== "string" ||
    !realizacionId
  ) {
    throw new Error(
      "REALIZACION_NO_ENCONTRADA"
    );
  }

  const snap = await db
    .collection("sesiones_tareas")
    .where(
      "realizacion_id",
      "==",
      realizacionId
    )
    .where("activa", "==", true)
    .get();

  if (snap.empty) {
    return null;
  }

  const sesionesValidas = [];

  for (const doc of snap.docs) {
    const sesion = {
      ref: doc.ref,
      ...doc.data()
    };

    const actividadHasta =
      timestampMs(
        sesion.actividad_valida_hasta
      );

    // Una sesión sin vencimiento válido o cuyo plazo
    // terminó debe cerrarse antes de continuar.
    if (
      !actividadHasta ||
      actividadHasta <= ahoraMs()
    ) {
      await cerrarSesionPorInactividad(
        sesion
      );

      continue;
    }

    sesionesValidas.push(sesion);
  }

  if (sesionesValidas.length > 1) {
    throw new Error(
      "SESIONES_ACTIVAS_DUPLICADAS"
    );
  }

  return sesionesValidas[0] || null;
}

async function obtenerEstado(uid, usuario, tarea) {
  let realizacion =
    await obtenerRealizacionUsuario(
      tarea.ref.id,
      uid
    );

  if (realizacion) {
    const vencimientoMs =
      timestampMs(
        realizacion.fecha_vencimiento
      );

    if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
}{
      await cerrarRealizacionPorCaducidad(
        realizacion.ref,
        "vencimiento_7_dias"
      );

      realizacion = null;
    }
  }

  let sesion = null;

  if (realizacion) {
    sesion = await obtenerSesionActual(
      realizacion.ref.id
    );
  }

  return {
    tarea: tareaPublica(tarea),

    realizacion:
      realizacionPublica(realizacion),

    sesion:
      sesionPublica(sesion)
  };
}

async function manejarInicio(
  uid,
  usuario,
  tarea
) {
  let realizacion =
    await obtenerRealizacionUsuario(
      tarea.ref.id,
      uid
    );

  if (realizacion) {
    const vencimientoMs =
      timestampMs(
        realizacion.fecha_vencimiento
      );

  if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
} {
      await cerrarRealizacionPorCaducidad(
        realizacion.ref,
        "vencimiento_7_dias"
      );

      realizacion = null;
    }
  }

    if (!realizacion) {
    realizacion =
      await obtenerOCrearRealizacion(
        tarea,
        usuario,
        uid
      );
  }

  // Cerrar sesiones vencidas y guardar su tiempo
  // antes de intentar iniciar una nueva.
  await obtenerSesionActivaUsuario(uid);

  const bloqueoRef =
    obtenerBloqueoUsuarioRef(uid);

  const sesionRef =
    db.collection("sesiones_tareas").doc();

  const resultado =
    await db.runTransaction(async (tx) => {
      // Todas las lecturas se realizan antes de escribir.
      const bloqueoSnap =
        await tx.get(bloqueoRef);

      const realizacionSnap =
        await tx.get(realizacion.ref);

      const sesionesQuery =
        db.collection("sesiones_tareas")
          .where("usuario_id", "==", uid)
          .where("activa", "==", true);

      const sesionesSnap =
        await tx.get(sesionesQuery);

      if (!realizacionSnap.exists) {
        throw new Error(
          "REALIZACION_NO_ENCONTRADA"
        );
      }

      const realizacionActual = {
        ref: realizacion.ref,
        ...realizacionSnap.data()
      };

      if (
        realizacionActual.usuario_id !== uid
      ) {
        throw new Error("NO_AUTORIZADO");
      }

      if (
        realizacionActual.estado !== "pendiente"
      ) {
        throw new Error(
          "REALIZACION_NO_DISPONIBLE"
        );
      }

      const ahoraTimestamp = ahora();
      const ahoraActualMs =
        ahoraTimestamp.toMillis();

      const sesionesActivas =
        sesionesSnap.docs.map((doc) => ({
          ref: doc.ref,
          ...doc.data()
        }));

      const sesionesVigentes =
        sesionesActivas.filter((sesion) => {
          const hasta = timestampMs(
            sesion.actividad_valida_hasta
          );

          return hasta && hasta > ahoraActualMs;
        });

      if (sesionesVigentes.length > 1) {
        throw new Error(
          "SESIONES_ACTIVAS_DUPLICADAS"
        );
      }

      const bloqueo =
        bloqueoSnap.exists
          ? bloqueoSnap.data()
          : null;

       if (sesionesVigentes.length === 1) {
        const existente =
          sesionesVigentes[0];

        if (
          existente.realizacion_id !==
          realizacion.ref.id
        ) {
          throw new Error(
            "OTRA_TAREA_ACTIVA"
          );
        }

        if (
          existente.tarea_id !==
            realizacionActual.tarea_id ||
          existente.usuario_id !== uid
        ) {
          throw new Error(
            "RELACION_SESION_INVALIDA"
          );
        }

        if (bloqueo) {
          if (
            bloqueo.usuario_id !== uid ||
            bloqueo.sesion_id !== existente.ref.id ||
            bloqueo.realizacion_id !== realizacion.ref.id ||
            bloqueo.tarea_id !== existente.tarea_id
          ) {
            throw new Error(
              "BLOQUEO_SESION_INVALIDO"
            );
          }
        } else {
          tx.set(bloqueoRef, {
            usuario_id: uid,
            tarea_id: existente.tarea_id,
            realizacion_id: existente.realizacion_id,
            sesion_id: existente.ref.id,
            actividad_valida_hasta:
              existente.actividad_valida_hasta,
            actualizado_en: ahoraTimestamp
          });
        }

        return {
          realizacion: realizacionActual,
          sesion: existente
        };
           }

      // Las sesiones vencidas deben cerrarse previamente
      // mediante obtenerSesionActivaUsuario(), que guarda
      // el tiempo pendiente antes de finalizar.
      const sesionesObsoletas =
        sesionesActivas.filter((sesion) => {
          const hasta = timestampMs(
            sesion.actividad_valida_hasta
          );

          return !hasta || hasta <= ahoraActualMs;
        });

      if (sesionesObsoletas.length > 0) {
        throw new Error("SESION_NO_ACTIVA");
      }

// No sobrescribir un bloqueo que todavía
// tenga referencias a una sesión anterior.
if (bloqueo) {
  const bloqueoTieneSesion =
    Boolean(
      bloqueo.sesion_id ||
      bloqueo.realizacion_id ||
      bloqueo.tarea_id
    );

  if (
    bloqueo.usuario_id !== uid ||
    bloqueoTieneSesion
  ) {
    throw new Error(
      "BLOQUEO_SESION_INVALIDO"
    );
  }
}

      const requeridoGuardado =
        Number(
          realizacionActual.tiempo_requerido_ms
        );

      const requeridoMs =
        Number.isFinite(requeridoGuardado) &&
        requeridoGuardado > 0
          ? requeridoGuardado
          : obtenerTiempoRequeridoMs(tarea);

      const minutosGuardados =
        Number(
          realizacionActual.tiempo_requerido_minutos
        );

      const requeridoMinutos =
        Number.isFinite(minutosGuardados) &&
        minutosGuardados > 0
          ? minutosGuardados
          : Number(tarea.tiempo_requerido);

      const actividadHasta =
        Timestamp.fromMillis(
          ahoraActualMs + ACTIVITY_WINDOW_MS
        );

      const datosSesion = {
        tarea_id:
          realizacionActual.tarea_id,

        realizacion_id:
          realizacion.ref.id,

        usuario_id: uid,

        activa: true,

        fecha_inicio: ahoraTimestamp,

        ultima_actividad: null,

        actividad_valida_hasta:
          actividadHasta,

        ultimo_punto_conteo:
          ahoraTimestamp,

        ultimo_heartbeat:
          ahoraTimestamp,

        tiempo_requerido_ms:
          requeridoMs,

        tiempo_requerido_minutos:
          requeridoMinutos,

        tiempo_activo_valido:
          Math.max(
            0,
            Number(
              realizacionActual.tiempo_activo_valido
            ) || 0
          ),

        tiempo_adicional:
          Math.max(
            0,
            Number(
              realizacionActual.tiempo_adicional
            ) || 0
          ),

        cantidad_heartbeat: 0,
        cantidad_actividades: 0
      };

      tx.create(sesionRef, datosSesion);

      tx.set(bloqueoRef, {
        usuario_id: uid,
        tarea_id:
          realizacionActual.tarea_id,
        realizacion_id:
          realizacion.ref.id,
        sesion_id: sesionRef.id,
        actividad_valida_hasta:
          actividadHasta,
        actualizado_en: ahoraTimestamp
      });

      return {
        realizacion: realizacionActual,
        sesion: {
          ref: sesionRef,
          ...datosSesion
        }
      };
    });

  return resultado;
}

async function manejarActividad(
  uid,
  tarea,
  realizacion
) {
  if (
    !realizacion?.ref ||
    realizacion.usuario_id !== uid
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const sesion =
    await obtenerSesionActual(
      realizacion.ref.id
    );

  if (!sesion) {
    throw new Error("SESION_NO_ACTIVA");
  }

  const bloqueoRef =
    obtenerBloqueoUsuarioRef(uid);

  const ahoraTimestamp = ahora();
  const ahoraActualMs =
    ahoraTimestamp.toMillis();

  let resultado = null;

  await db.runTransaction(async (tx) => {
    const sesionSnap =
      await tx.get(sesion.ref);

    const realizacionSnap =
      await tx.get(realizacion.ref);

    const bloqueoSnap =
      await tx.get(bloqueoRef);

    if (
      !sesionSnap.exists ||
      !realizacionSnap.exists
    ) {
      throw new Error(
        "SESION_NO_ENCONTRADA"
      );
    }

    if (!bloqueoSnap.exists) {
      throw new Error(
        "BLOQUEO_SESION_INVALIDO"
      );
    }

    const sesionActual = {
      ref: sesion.ref,
      ...sesionSnap.data()
    };

    const realizacionActual = {
      ref: realizacion.ref,
      ...realizacionSnap.data()
    };

    const bloqueoActual =
      bloqueoSnap.data();

    if (
      sesionActual.activa !== true
    ) {
      throw new Error("SESION_NO_ACTIVA");
    }

    if (
      sesionActual.usuario_id !== uid ||
      realizacionActual.usuario_id !== uid
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    if (
      sesionActual.realizacion_id !==
        realizacion.ref.id ||
      realizacionActual.tarea_id !==
        tarea.ref.id ||
      sesionActual.tarea_id !==
        tarea.ref.id
    ) {
      throw new Error(
        "RELACION_SESION_INVALIDA"
      );
    }

    if (
      bloqueoActual.usuario_id !== uid ||
      bloqueoActual.sesion_id !==
        sesion.ref.id ||
      bloqueoActual.realizacion_id !==
        realizacion.ref.id ||
      bloqueoActual.tarea_id !==
        tarea.ref.id
    ) {
      throw new Error(
        "BLOQUEO_SESION_INVALIDO"
      );
    }

    if (
      realizacionActual.estado !==
      "pendiente"
    ) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    const vencimientoMs =
      timestampMs(
        realizacionActual.fecha_vencimiento
      );

    if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
}{
      throw new Error(
        "REALIZACION_VENCIDA"
      );
    }

    const actividadHasta =
      timestampMs(
        sesionActual.actividad_valida_hasta
      );

    if (
      !actividadHasta ||
      actividadHasta <= ahoraActualMs
    ) {
      throw new Error("SESION_NO_ACTIVA");
    }

    const valores =
      calcularNuevoTiempo(
        sesionActual,
        realizacionActual,
        tarea,
        ahoraActualMs
      );

    const nuevaActividadHasta =
      Timestamp.fromMillis(
        ahoraActualMs +
          ACTIVITY_WINDOW_MS
      );

    registrarTiempoSesion(
      tx,
      sesionActual,
      realizacionActual,
      valores,
      ahoraTimestamp
    );

    tx.update(sesionActual.ref, {
      ultima_actividad:
        ahoraTimestamp,

      actividad_valida_hasta:
        nuevaActividadHasta,

      cantidad_actividades:
        FieldValue.increment(1)
    });

    tx.update(realizacionActual.ref, {
      cantidad_actividades:
        FieldValue.increment(1)
    });

    tx.update(bloqueoRef, {
      actividad_valida_hasta:
        nuevaActividadHasta,

      actualizado_en:
        ahoraTimestamp
    });

    resultado = {
      tiempo_activo_valido:
        valores.tiempo_activo_valido,

      tiempo_adicional:
        valores.tiempo_adicional
    };
  });

  return resultado;
}
                          
async function manejarHeartbeat(
  uid,
  realizacion
) {
  if (
    !realizacion?.ref ||
    realizacion.usuario_id !== uid
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const sesion =
    await obtenerSesionActual(
      realizacion.ref.id
    );

  if (!sesion) {
    throw new Error("SESION_NO_ACTIVA");
  }

  const bloqueoRef =
    obtenerBloqueoUsuarioRef(uid);

  const ahoraTimestamp = ahora();
  const ahoraActualMs =
    ahoraTimestamp.toMillis();

  await db.runTransaction(async (tx) => {
    const sesionSnap =
      await tx.get(sesion.ref);

    const realizacionSnap =
      await tx.get(realizacion.ref);

    const bloqueoSnap =
      await tx.get(bloqueoRef);

    if (
      !sesionSnap.exists ||
      !realizacionSnap.exists
    ) {
      throw new Error(
        "SESION_NO_ENCONTRADA"
      );
    }

    if (!bloqueoSnap.exists) {
      throw new Error(
        "BLOQUEO_SESION_INVALIDO"
      );
    }

    const sesionActual = {
      ref: sesion.ref,
      ...sesionSnap.data()
    };

    const realizacionActual = {
      ref: realizacion.ref,
      ...realizacionSnap.data()
    };

    const bloqueoActual =
      bloqueoSnap.data();

    if (
      sesionActual.activa !== true
    ) {
      throw new Error("SESION_NO_ACTIVA");
    }

    if (
      sesionActual.usuario_id !== uid ||
      realizacionActual.usuario_id !== uid
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    if (
      sesionActual.realizacion_id !==
        realizacion.ref.id ||
      sesionActual.tarea_id !==
        realizacionActual.tarea_id
    ) {
      throw new Error(
        "RELACION_SESION_INVALIDA"
      );
    }

    if (
      bloqueoActual.usuario_id !== uid ||
      bloqueoActual.sesion_id !==
        sesion.ref.id ||
      bloqueoActual.realizacion_id !==
        realizacion.ref.id ||
      bloqueoActual.tarea_id !==
        sesionActual.tarea_id
    ) {
      throw new Error(
        "BLOQUEO_SESION_INVALIDO"
      );
    }

    if (
      realizacionActual.estado !==
      "pendiente"
    ) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    const vencimientoMs =
      timestampMs(
        realizacionActual.fecha_vencimiento
      );

    if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
}{
      throw new Error(
        "REALIZACION_VENCIDA"
      );
    }

    const actividadHasta =
      timestampMs(
        sesionActual.actividad_valida_hasta
      );

    if (
      !actividadHasta ||
      actividadHasta <= ahoraActualMs
    ) {
      throw new Error("SESION_NO_ACTIVA");
    }

    // El heartbeat solo registra metadatos.
    // No suma tiempo ni renueva la actividad o el bloqueo.
    tx.update(sesionActual.ref, {
      ultimo_heartbeat:
        ahoraTimestamp,

      cantidad_heartbeat:
        FieldValue.increment(1)
    });
  });
}
        
async function manejarCompletar(
  uid,
  tarea,
  realizacion
) {
  if (
    !realizacion?.ref ||
    realizacion.usuario_id !== uid
  ) {
    throw new Error("NO_AUTORIZADO");
  }

  const sesion =
    await obtenerSesionActual(
      realizacion.ref.id
    );

  const bloqueoRef =
    obtenerBloqueoUsuarioRef(uid);

  const estadisticasRef =
    db.collection(
      "estadisticas_usuario"
    ).doc(uid);

  const historialRef =
    db.collection(
      "historial_realizaciones"
    ).doc(realizacion.ref.id);

  const progresoRef =
    db.collection(
      "progreso_tareas"
    ).doc();

  const ahoraTimestamp = ahora();
  const ahoraActualMs =
    ahoraTimestamp.toMillis();

  const fechaArgentina =
    obtenerFechaArgentina();

  const diaTrabajadoRef =
    obtenerDiaTrabajadoRef(
      uid,
      fechaArgentina
    );

  let resultado = null;

  await db.runTransaction(async (tx) => {
    // TODAS LAS LECTURAS PRIMERO.

    const realizacionSnap =
      await tx.get(realizacion.ref);

    if (!realizacionSnap.exists) {
      throw new Error(
        "REALIZACION_NO_ENCONTRADA"
      );
    }

    const realizacionActual = {
      ref: realizacion.ref,
      ...realizacionSnap.data()
    };

    if (
      realizacionActual.usuario_id !== uid
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    if (
      realizacionActual.estado === "completada"
    ) {
      resultado = {
        completada: true,
        ya_completada: true,
        tiempo_activo_valido:
          Number(
            realizacionActual.tiempo_activo_valido
          ) || 0,
        tiempo_adicional:
          Number(
            realizacionActual.tiempo_adicional
          ) || 0
      };

      return;
    }

    if (
      realizacionActual.estado !== "pendiente"
    ) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    const vencimientoMs =
      timestampMs(
        realizacionActual.fecha_vencimiento
      );

if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
}{
      throw new Error(
        "REALIZACION_VENCIDA"
      );
    }

    let sesionActual = null;

    if (sesion) {
      const sesionSnap =
        await tx.get(sesion.ref);

      if (!sesionSnap.exists) {
        throw new Error(
          "SESION_NO_ENCONTRADA"
        );
      }

      sesionActual = {
        ref: sesion.ref,
        ...sesionSnap.data()
      };
    }

    const bloqueoSnap =
      await tx.get(bloqueoRef);

    const estadisticasSnap =
      await tx.get(estadisticasRef);

    const diaTrabajadoSnap =
      await tx.get(diaTrabajadoRef);

    // TODAS LAS LECTURAS TERMINARON.
    // A PARTIR DE AQUÍ SE PUEDE ESCRIBIR.

    if (sesionActual) {
      if (
        sesionActual.activa !== true
      ) {
        throw new Error(
          "SESION_NO_ACTIVA"
        );
      }

      if (
        sesionActual.usuario_id !== uid ||
        sesionActual.realizacion_id !==
          realizacion.ref.id ||
        sesionActual.tarea_id !==
          realizacionActual.tarea_id
      ) {
        throw new Error(
          "RELACION_SESION_INVALIDA"
        );
      }

      if (!bloqueoSnap.exists) {
        throw new Error(
          "BLOQUEO_SESION_INVALIDO"
        );
      }

      const bloqueo =
        bloqueoSnap.data();

      if (
        bloqueo.usuario_id !== uid ||
        bloqueo.sesion_id !==
          sesion.ref.id ||
        bloqueo.realizacion_id !==
          realizacion.ref.id ||
        bloqueo.tarea_id !==
          realizacionActual.tarea_id
      ) {
        throw new Error(
          "BLOQUEO_SESION_INVALIDO"
        );
      }

      const actividadHasta =
        timestampMs(
          sesionActual.actividad_valida_hasta
        );

      if (
        !actividadHasta ||
        actividadHasta <= ahoraActualMs
      ) {
        throw new Error(
          "SESION_NO_ACTIVA"
        );
      }
    }

    let tiempoActivo = Math.max(
      0,
      Number(
        realizacionActual.tiempo_activo_valido
      ) || 0
    );

    let tiempoAdicional = Math.max(
      0,
      Number(
        realizacionActual.tiempo_adicional
      ) || 0
    );

    let requeridoMs = Number(
      realizacionActual.tiempo_requerido_ms
    );

    if (
      !Number.isFinite(requeridoMs) ||
      requeridoMs <= 0
    ) {
      const minutosGuardados = Number(
        realizacionActual.tiempo_requerido_minutos
      );

      if (
        Number.isFinite(minutosGuardados) &&
        minutosGuardados > 0
      ) {
        requeridoMs =
          minutosGuardados * 60 * 1000;
      }
    }

    if (
      !Number.isFinite(requeridoMs) ||
      requeridoMs <= 0
    ) {
      requeridoMs =
        obtenerTiempoRequeridoMs(tarea);
    }

    if (sesionActual) {
      const valores =
        calcularNuevoTiempo(
          sesionActual,
          realizacionActual,
          tarea,
          ahoraActualMs
        );

      tiempoActivo =
        valores.tiempo_activo_valido;

      tiempoAdicional =
        valores.tiempo_adicional;

      requeridoMs =
        valores.requerido_ms;

      if (
        tiempoActivo < requeridoMs
      ) {
        registrarTiempoSesion(
          tx,
          sesionActual,
          realizacionActual,
          valores,
          ahoraTimestamp
        );

        resultado = {
          completada: false,
          tiempo_activo_valido:
            tiempoActivo,
          tiempo_adicional:
            tiempoAdicional
        };

        return;
      }
    }

    if (
      tiempoActivo < requeridoMs
    ) {
      resultado = {
        completada: false,
        tiempo_activo_valido:
          tiempoActivo,
        tiempo_adicional:
          tiempoAdicional
      };

      return;
    }

    const tareaId =
      realizacionActual.tarea_id;

    const tituloTarea =
      realizacionActual.titulo_tarea ||
      tarea?.titulo ||
      null;

    const email =
      realizacionActual.email || null;

    const tiempoTotal =
      tiempoActivo + tiempoAdicional;

    const minutosTotales =
      minutosCompletos(tiempoTotal);

    // Cerrar sesión y liberar únicamente su bloqueo.
    if (sesionActual) {
      tx.update(sesionActual.ref, {
        activa: false,

        tiempo_activo_valido:
          tiempoActivo,

        tiempo_adicional:
          tiempoAdicional,

        fecha_finalizacion:
          ahoraTimestamp,

        actividad_valida_hasta:
          ahoraTimestamp,

        ultimo_punto_conteo:
          ahoraTimestamp
      });

      if (
  bloqueoCoincideConSesion(
    bloqueo,
    sesionActual
  )
) {
  liberarBloqueoSesion(
    tx,
    bloqueoRef,
    ahoraTimestamp
  );
} else {
  throw new Error(
    "BLOQUEO_SESION_INVALIDO"
  );
      }
    }

    tx.update(realizacionActual.ref, {
      estado: "completada",

      fecha_cierre:
        ahoraTimestamp,

      fecha_completada:
        ahoraTimestamp,

      tiempo_activo_valido:
        tiempoActivo,

      tiempo_adicional:
        tiempoAdicional
    });

    tx.set(historialRef, {
      tarea_id: tareaId,

      realizacion_id:
        realizacion.ref.id,

      usuario_id: uid,

      email,

      titulo_tarea: tituloTarea,

      descripcion_tarea:
        realizacionActual.descripcion_tarea || null,

      categoria_tarea:
        realizacionActual.categoria_tarea || null,

      link_url_tarea:
        realizacionActual.link_url_tarea || null,

      fecha_inicio:
        realizacionActual.fecha_inicio || null,

      fecha_vencimiento:
        realizacionActual.fecha_vencimiento || null,

      fecha_cierre:
        ahoraTimestamp,

      fecha_completada:
        ahoraTimestamp,

      estado_final: "completada",

      tiempo_requerido_ms:
        requeridoMs,

     tiempo_requerido_minutos:
       realizacionActual.tiempo_requerido_minutos ?? null,

     fase_tarea:
      realizacionActual.fase_tarea ?? null,

     repetible:
      typeof realizacionActual.repetible === "boolean"
      ? realizacionActual.repetible
      : null,

      tiempo_activo_valido:
        tiempoActivo,

      tiempo_adicional:
        tiempoAdicional,

      tiempo_total:
        tiempoTotal
    });

    tx.set(progresoRef, {
      email,

      fecha_realizada:
        ahoraTimestamp,

      minutos_realizados:
        minutosTotales,

      tarea_id: tareaId,

      usuario_id: uid,

      veces_realizada: 1,

      titulo_tarea: tituloTarea
    });

    // La marca determinista impide contar dos veces
    // el mismo día, incluso con tareas simultáneas.
    const nuevoDiaTrabajado =
      !diaTrabajadoSnap.exists;

    if (nuevoDiaTrabajado) {
      tx.create(diaTrabajadoRef, {
        usuario_id: uid,
        fecha: fechaArgentina,
        primera_realizacion_id:
          realizacion.ref.id,
        fecha_registro:
          ahoraTimestamp
      });
    }

    if (estadisticasSnap.exists) {
      const estadisticas =
        estadisticasSnap.data();

      const ultimaFechaMs =
        timestampMs(
          estadisticas.ultima_fecha_trabajo
        );

      const actualizaUltimaFecha =
        !ultimaFechaMs ||
        ahoraActualMs > ultimaFechaMs;

      const cambiosEstadisticas = {
        email:
          estadisticas.email || email,

        minutos_acumulados:
          FieldValue.increment(
            minutosTotales
          ),

        tareas_realizadas:
          FieldValue.increment(1),

        usuario_id: uid
      };

      if (nuevoDiaTrabajado) {
        cambiosEstadisticas.dias_trabajados =
          FieldValue.increment(1);
      }

      if (actualizaUltimaFecha) {
        cambiosEstadisticas.ultima_fecha_trabajo =
          ahoraTimestamp;
      }

      tx.update(
        estadisticasRef,
        cambiosEstadisticas
      );
    } else {
      tx.set(estadisticasRef, {
        email,

        minutos_acumulados:
          minutosTotales,

        tareas_realizadas: 1,

        dias_trabajados:
          nuevoDiaTrabajado ? 1 : 0,

        ultima_fecha_trabajo:
          ahoraTimestamp,

        usuario_id: uid
      });
    }

    resultado = {
      completada: true,

      tiempo_activo_valido:
        tiempoActivo,

      tiempo_adicional:
        tiempoAdicional
    };
  });

  if (
    resultado &&
    resultado.completada === false
  ) {
    throw new Error(
      "TIEMPO_INSUFICIENTE"
    );
  }

  return resultado;
}

function mensajeError(error) {
  const mensajes = {
    NO_AUTORIZADO: [
      401,
      "No autorizado."
    ],

    USUARIO_NO_ENCONTRADO: [
      404,
      "Usuario no encontrado."
    ],

    USUARIO_INACTIVO: [
      403,
      "No se puede acceder a la plataforma con esta cuenta."
    ],

    TAREA_ID_REQUERIDO: [
      400,
      "Falta el identificador de la tarea."
    ],

    TAREA_ID_INVALIDO: [
      400,
      "El identificador de la tarea no es válido."
    ],

    TAREA_NO_ENCONTRADA: [
      404,
      "La tarea no existe."
    ],

    TAREA_NO_DISPONIBLE: [
      400,
      "La tarea no está disponible."
    ],

    TAREA_NO_CORRESPONDE: [
      403,
      "La tarea no corresponde al usuario."
    ],

    TAREA_YA_REALIZADA: [
      409,
      "Esta tarea ya fue realizada y no admite otra realización."
    ],

    REALIZACION_ANTERIOR_NO_COMPLETADA: [
      409,
      "Debés completar la realización anterior antes de iniciar otra."
    ],

    REALIZACIONES_DUPLICADAS: [
      409,
      "No se pudo procesar la tarea. Intentá nuevamente más tarde."
    ],

    TIEMPO_REQUERIDO_INVALIDO: [
      400,
      "El tiempo requerido de la tarea no es válido."
    ],

    OTRA_TAREA_ACTIVA: [
      409,
      "Ya existe otra tarea activa."
    ],

    SESION_NO_ACTIVA: [
      409,
      "La tarea no está activa."
    ],

    SESION_NO_ENCONTRADA: [
      404,
      "No se encontró la sesión."
    ],

    SESIONES_ACTIVAS_DUPLICADAS: [
      409,
      "No se pudo procesar la tarea. Intentá nuevamente más tarde."
    ],

    RELACION_SESION_INVALIDA: [
      409,
      "No se pudo procesar la tarea. Intentá nuevamente más tarde."
    ],

    REALIZACION_NO_ENCONTRADA: [
      404,
      "No se encontró la realización."
    ],

    REALIZACION_NO_DISPONIBLE: [
      409,
      "La realización ya no está disponible."
    ],

    REALIZACION_VENCIDA: [
      409,
      "La realización venció."
    ],

    TIEMPO_INSUFICIENTE: [
      400,
      "Todavía no se alcanzó el tiempo requerido."
    ],

    ERROR_INTERNO: [
      500,
      "Ocurrió un error al procesar la tarea."
    ]
  };

  const clave =
    error && typeof error.message === "string"
      ? error.message
      : "ERROR_INTERNO";

  return (
    mensajes[clave] || [
      500,
      "Ocurrió un error al procesar la tarea."
    ]
  );
}

module.exports = async function handler(
  req,
  res
) {
  try {
    if (
      req.method !== "GET" &&
      req.method !== "POST"
    ) {
      return respuesta(res, 405, {
        ok: false,
        error: "METODO_NO_PERMITIDO"
      });
    }

    const decoded =
      await verificarToken(req);

    const uid = decoded.uid;

    const usuario =
      await obtenerUsuario(uid);

    const tareaId =
      req.method === "GET"
        ? req.query?.id
        : req.body?.tarea_id;

    const accion =
      req.method === "GET"
        ? "estado"
        : req.body?.accion;

    // Validar la acción antes de consultar Firestore.
    const accionesPermitidas = [
      "estado",
      "iniciar",
      "actividad",
      "heartbeat",
      "completar"
    ];

    if (
      !accionesPermitidas.includes(accion)
    ) {
      return respuesta(res, 400, {
        ok: false,
        error: "ACCION_NO_VALIDA"
      });
    }

    if (
      typeof tareaId !== "string" ||
      !tareaId.trim() ||
      tareaId.includes("/")
    ) {
      throw new Error(
        "TAREA_ID_INVALIDO"
      );
    }

    let tarea = null;
    let tareaNoEncontrada = false;

    try {
      tarea = await obtenerTarea(tareaId);
    } catch (error) {
      if (
        error.message !==
        "TAREA_NO_ENCONTRADA"
      ) {
        throw error;
      }

      tareaNoEncontrada = true;
    }

    // Buscar primero una realización pendiente,
    // independientemente de que la tarea siga existiendo.
    let realizacion =
      await obtenerRealizacionUsuario(
        tareaId,
        uid
      );

    if (tareaNoEncontrada && !realizacion) {
      throw new Error(
        "TAREA_NO_ENCONTRADA"
      );
    }
    
    // Si existe una realización pendiente, respetar
    // siempre los datos guardados al momento de iniciarla.
        if (realizacion) {
      const obtenerSnapshot = (
        campoRealizacion,
        campoTarea,
        valorPredeterminado = ""
      ) => {
        if (
          Object.prototype.hasOwnProperty.call(
            realizacion,
            campoRealizacion
          )
        ) {
          return realizacion[campoRealizacion];
        }

        return tarea?.[campoTarea] ??
          valorPredeterminado;
      };

      tarea = {
        ...(tarea || {}),

        ref: db.collection("tareas").doc(tareaId),

        titulo:
          obtenerSnapshot(
            "titulo_tarea",
            "titulo"
          ),

        descripcion:
          obtenerSnapshot(
            "descripcion_tarea",
            "descripcion"
          ),

        categoria:
          obtenerSnapshot(
            "categoria_tarea",
            "categoria"
          ),

        fase:
          obtenerSnapshot(
            "fase_tarea",
            "fase",
            null
          ),

        link_url:
          obtenerSnapshot(
            "link_url_tarea",
            "link_url"
          ),

        tiempo_requerido:
          obtenerSnapshot(
            "tiempo_requerido_minutos",
            "tiempo_requerido",
            0
          ),

        retirada: false
      };
      }

    if (!tarea) {
      throw new Error("TAREA_NO_ENCONTRADA");
    }

    if (accion === "estado") {
      const estado =
        await obtenerEstado(
          uid,
          usuario,
          tarea
        );

      return respuesta(res, 200, {
        ok: true,
        ...estado
      });
    }

    if (accion === "iniciar") {
      const resultado =
        await manejarInicio(
          uid,
          usuario,
          tarea
        );

      return respuesta(res, 200, {
        ok: true,

        tarea:
          tareaPublica(tarea),

        realizacion:
          realizacionPublica(
            resultado.realizacion
          ),

        sesion:
          sesionPublica(
            resultado.sesion
          )
      });
    }

    if (!realizacion) {
      realizacion =
        await obtenerRealizacionUsuario(
          tarea.ref.id,
          uid
        );
    }

    if (!realizacion) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    if (
      realizacion.usuario_id !== uid ||
      realizacion.tarea_id !== tarea.ref.id
    ) {
      throw new Error("NO_AUTORIZADO");
    }

    const vencimientoMs =
      timestampMs(
        realizacion.fecha_vencimiento
      );

    if (!Number.isFinite(vencimientoMs)) {
  throw new Error(
    "FECHA_VENCIMIENTO_INVALIDA"
  );
}

if (vencimientoMs <= ahoraMs()) {
  throw new Error(
    "REALIZACION_VENCIDA"
  );
} {
      await cerrarRealizacionPorCaducidad(
        realizacion.ref,
        "vencimiento_7_dias"
      );

      throw new Error(
        "REALIZACION_VENCIDA"
      );
    }

    if (accion === "actividad") {
      const resultado =
        await manejarActividad(
          uid,
          tarea,
          realizacion
        );

      return respuesta(res, 200, {
        ok: true,

        tiempo_activo_valido:
          resultado.tiempo_activo_valido,

        tiempo_adicional:
          resultado.tiempo_adicional
      });
    }

    if (accion === "heartbeat") {
      await manejarHeartbeat(
        uid,
        realizacion
      );

      return respuesta(res, 200, {
        ok: true
      });
    }

    if (accion === "completar") {
      const resultado =
        await manejarCompletar(
          uid,
          tarea,
          realizacion
        );

      return respuesta(res, 200, {
        ok: true,

        completada:
          resultado.completada,

        tiempo_activo_valido:
          resultado.tiempo_activo_valido,

        tiempo_adicional:
          resultado.tiempo_adicional
      });
    }

  } catch (error) {
    const [status, mensaje] =
      mensajeError(error);

const codigosPublicos = new Set([
  "NO_AUTORIZADO",
  "TAREA_ID_INVALIDO",
  "TAREA_NO_ENCONTRADA",
  "TAREA_NO_DISPONIBLE",
  "TAREA_NO_CORRESPONDE",
  "TAREA_YA_REALIZADA",
  "REALIZACION_ANTERIOR_NO_COMPLETADA",
  "OTRA_TAREA_ACTIVA",
  "SESION_NO_ACTIVA",
  "SESION_NO_ENCONTRADA",
  "REALIZACION_NO_ENCONTRADA",
  "REALIZACION_NO_DISPONIBLE",
  "REALIZACION_VENCIDA",
  "TIEMPO_INSUFICIENTE"
]);

const codigoSeguro =
  status < 500 &&
  codigosPublicos.has(error?.message)
    ? error.message
    : "ERROR_INTERNO";

    return respuesta(res, status, {
      ok: false,
      error: codigoSeguro,
      mensaje
    });
  }
};
