hereconst admin = require("firebase-admin");

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

const ACTIVITY_WINDOW_MS = 30000;
const HEARTBEAT_INTERVALO_MS = 10000;
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

function faseCoincide(usuario, tarea) {
  if (!usuario || !tarea) return false;

  if (
    usuario.fase === undefined ||
    usuario.fase === null
  ) {
    return Number(tarea.fase) === 1;
  }

  return (
    String(usuario.fase) ===
    String(tarea.fase)
  );
}

async function verificarToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    throw new Error("NO_AUTORIZADO");
  }

  const token =
    authorization.substring(7).trim();

  if (!token) {
    throw new Error("NO_AUTORIZADO");
  }

  return admin.auth().verifyIdToken(token);
}

async function obtenerUsuario(uid) {
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
    ref,
    ...usuario
  };
}

async function obtenerTarea(tareaId) {
  if (!tareaId) {
    throw new Error("TAREA_ID_REQUERIDO");
  }

  const ref =
    db.collection("tareas").doc(tareaId);

  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error("TAREA_NO_ENCONTRADA");
  }

  return {
    ref,
    ...snap.data()
  };
}

function tareaRetirada(tarea) {
  return tarea.retirada === true;
}

function tareaDisponibleParaNuevaRealizacion(tarea) {
  return (
    tarea.activa === true &&
    !tareaRetirada(tarea)
  );
}

function tareaPublica(tarea) {
  return {
    id: tarea.ref.id,
    titulo: tarea.titulo || "",
    descripcion: tarea.descripcion || "",
    categoria: tarea.categoria || "",
    fase: tarea.fase ?? null,
    link_url: tarea.link_url || "",
    tiempo_requerido:
      Number(tarea.tiempo_requerido) || 0
  };
}

function realizacionPublica(realizacion) {
  if (!realizacion) return null;

  return {
    id: realizacion.ref.id,
    tarea_id: realizacion.tarea_id,
    usuario_id: realizacion.usuario_id,
    fecha_inicio:
      realizacion.fecha_inicio || null,
    fecha_vencimiento:
      realizacion.fecha_vencimiento || null,
    estado: realizacion.estado || null,
    tiempo_activo_valido:
      Number(
        realizacion.tiempo_activo_valido
      ) || 0
  };
}

function sesionPublica(
  sesion,
  tiempoCalculado = null
) {
  if (!sesion) return null;

  const tiempoActivo =
    tiempoCalculado?.tiempo_activo_valido ??
    Number(sesion.tiempo_activo_valido) ??
    0;

  return {
    activa: sesion.activa === true,
    tiempo_activo_valido: tiempoActivo,
    tiempo_requerido_alcanzado:
      tiempoActivo >=
      Number(sesion.tiempo_requerido_ms || 0)
  };
}

async function obtenerRealizacionUsuario(
  tareaId,
  uid
) {
  const snap = await db
    .collection("realizaciones_tareas")
    .where("tarea_id", "==", tareaId)
    .where("usuario_id", "==", uid)
    .where("estado", "==", "pendiente")
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];

  return {
    ref: doc.ref,
    ...doc.data()
  };
}

async function cerrarRealizacionPorCaducidad(
  ref,
  motivo
) {
  const ahoraTimestamp = ahora();

  await db.runTransaction(async (tx) => {
    const actualSnap = await tx.get(ref);

    if (!actualSnap.exists) return;

    const actual = actualSnap.data();

    if (actual.estado !== "pendiente") {
      return;
    }

    const historialRef =
      db.collection("historial_realizaciones")
        .doc();

    tx.update(ref, {
      estado: "vencida",
      fecha_cierre: ahoraTimestamp,
      motivo_cierre: motivo
    });

    tx.set(historialRef, {
      tarea_id: actual.tarea_id,
      usuario_id: actual.usuario_id,
      email: actual.email || null,
      titulo_tarea:
        actual.titulo_tarea || null,
      fecha_inicio:
        actual.fecha_inicio || null,
      fecha_vencimiento:
        actual.fecha_vencimiento || null,
      fecha_cierre: ahoraTimestamp,
      motivo_cierre: motivo,
      estado_final: "vencida",
      tiempo_activo_valido:
        Number(
          actual.tiempo_activo_valido
        ) || 0,
      tiempo_adicional:
        Number(actual.tiempo_adicional) || 0
    });
  });
}

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

    if (
      vencimientoMs &&
      vencimientoMs <= ahoraMs()
    ) {
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
    !tareaDisponibleParaNuevaRealizacion(
      tarea
    )
  ) {
    throw new Error(
      "TAREA_NO_DISPONIBLE"
    );
  }

  if (!faseCoincide(usuario, tarea)) {
    throw new Error(
      "TAREA_NO_CORRESPONDE"
    );
  }

  const fechaInicio = ahora();

  const fechaVencimiento =
    Timestamp.fromMillis(
      fechaInicio.toMillis() +
        DURACION_REALIZACION_MS
    );

  const ref =
    db.collection("realizaciones_tareas")
      .doc();

  const datos = {
    tarea_id: tarea.ref.id,
    usuario_id: uid,
    email: usuario.email || null,
    titulo_tarea:
      tarea.titulo || null,

    fecha_inicio: fechaInicio,
    fecha_vencimiento:
      fechaVencimiento,

    estado: "pendiente",

    tiempo_activo_valido: 0,
    tiempo_adicional: 0,

    cantidad_pausas: 0,
    cantidad_reanudaciones: 0,
    cantidad_heartbeat: 0,
    cantidad_actividades: 0
  };

  await ref.set(datos);

  return {
    ref,
    ...datos
  };
}

function calcularTiempoHastaAhora(
  sesion,
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

  if (!ultimoPunto || !actividadHasta) {
    return 0;
  }

  const limite =
    Math.min(
      ahoraActualMs,
      actividadHasta
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
  const requeridoMs =
    obtenerTiempoRequeridoMs(tarea);

  const activoActual = Math.max(
    0,
    Number(
      realizacion.tiempo_activo_valido
    ) || 0
  );

  const adicionalActual = Math.max(
    0,
    Number(
      realizacion.tiempo_adicional
    ) || 0
  );

  const pendiente =
    calcularTiempoHastaAhora(
      sesion,
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
  sesionRef,
  realizacionRef,
  valores,
  ahoraTimestamp
) {
  tx.update(sesionRef, {
    tiempo_activo_valido:
      valores.tiempo_activo_valido,

    tiempo_adicional:
      valores.tiempo_adicional,

    ultimo_punto_conteo:
      ahoraTimestamp
  });

  tx.update(realizacionRef, {
    tiempo_activo_valido:
      valores.tiempo_activo_valido,

    tiempo_adicional:
      valores.tiempo_adicional
  });
}

async function cerrarSesionPorInactividad(
  sesion,
  uid
) {
  const sesionRef = db.collection("sesiones_tareas").doc(uid);
  const realizacionRef =
    db.collection("realizaciones_tareas")
      .doc(sesion.realizacion_id);

  await db.runTransaction(async (tx) => {
    const sesionSnap =
      await tx.get(sesionRef);

    const realizacionSnap =
      await tx.get(realizacionRef);

    if (
      !sesionSnap.exists ||
      !realizacionSnap.exists
    ) {
      return;
    }

    const sesionActual = {
      ref: sesionRef,
      ...sesionSnap.data()
    };

    const realizacionActual = {
      ref: realizacionRef,
      ...realizacionSnap.data()
    };

    if (sesionActual.activa !== true) {
      return;
    }

    const tareaSnap = await tx.get(db.collection("tareas").doc(sesionActual.tarea_id));
    const tareaObj = tareaSnap.exists ? tareaSnap.data() : { tiempo_requerido: sesionActual.tiempo_requerido_minutos };

    const ahoraTimestamp = ahora();

    const valores =
      calcularNuevoTiempo(
        sesionActual,
        realizacionActual,
        tareaObj
      );

    tx.update(sesionRef, {
      activa: false,

      tiempo_activo_valido:
        valores.tiempo_activo_valido,

      tiempo_adicional:
        valores.tiempo_adicional,

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
  });
}

async function obtenerSesionActual(
  realizacionId,
  uid
) {
  const sesionRef = db.collection("sesiones_tareas").doc(uid);
  const snap = await sesionRef.get();

  if (!snap.exists) {
    const legacySnap = await db.collection("sesiones_tareas")
      .where("usuario_id", "==", uid)
      .where("realizacion_id", "==", realizacionId)
      .where("activa", "==", true)
      .limit(1)
      .get();

    if (legacySnap.empty) return null;

    const legacyDoc = legacySnap.docs[0];
    const legacyData = legacyDoc.data();
    const sesionLegacy = { ref: legacyDoc.ref, ...legacyData };

    const actividadHasta = timestampMs(sesionLegacy.actividad_valida_hasta);
    if (!actividadHasta || actividadHasta <= ahoraMs()) {
      await cerrarSesionPorInactividad(sesionLegacy, uid);
      return null;
    }

    return sesionLegacy;
  }

  const sesion = {
    ref: sesionRef,
    ...snap.data()
  };

  if (sesion.realizacion_id !== realizacionId) {
    return null;
  }

  const actividadHasta =
    timestampMs(
      sesion.actividad_valida_hasta
    );

  if (
    !actividadHasta ||
    actividadHasta <= ahoraMs()
  ) {
    await cerrarSesionPorInactividad(
      sesion,
      uid
    );

    return null;
  }

  if (sesion.activa !== true) {
    return null;
  }

  return sesion;
}

async function manejarInicio(
  uid,
  usuario,
  tarea
) {
  if (!faseCoincide(usuario, tarea)) {
    throw new Error(
      "TAREA_NO_CORRESPONDE"
    );
  }

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

    if (
      vencimientoMs &&
      vencimientoMs <= ahoraMs()
    ) {
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

  const sesionRef = db.collection("sesiones_tareas").doc(uid);
  const requeridoMs = obtenerTiempoRequeridoMs(tarea);
  const realizacionRef = realizacion.ref;

  let sesionResultado = null;

  await db.runTransaction(async (tx) => {
    const sesionSnap = await tx.get(sesionRef);
    const realizacionSnap = await tx.get(realizacionRef);

    if (!realizacionSnap.exists) {
      throw new Error("REALIZACION_NO_ENCONTRADA");
    }

    const realizacionActual = {
      ref: realizacionRef,
      ...realizacionSnap.data()
    };

    if (sesionSnap.exists) {
      const sesionActual = {
        ref: sesionRef,
        ...sesionSnap.data()
      };

      const actividadHasta = timestampMs(sesionActual.actividad_valida_hasta);
      const sesionActivaReal = sesionActual.activa === true && actividadHasta && actividadHasta > ahoraMs();

      if (sesionActivaReal) {
        if (sesionActual.realizacion_id !== realizacion.ref.id) {
          throw new Error("OTRA_TAREA_ACTIVA");
        }

        sesionResultado = sesionActual;
        return;
      } else if (sesionActual.activa === true) {
        const valores = calcularNuevoTiempo(sesionActual, realizacionActual, tarea);
        registrarTiempoSesion(tx, sesionRef, realizacionRef, valores, ahora());
      }
    }

    const ahoraTimestamp = ahora();
    const actividadValidaHastaTimestamp = Timestamp.fromMillis(ahoraMs() + ACTIVITY_WINDOW_MS);

    const datosSesion = {
      tarea_id: tarea.ref.id,
      realizacion_id: realizacion.ref.id,
      usuario_id: uid,
      activa: true,
      fecha_inicio: ahoraTimestamp,
      ultima_actividad: null,
      actividad_valida_hasta: actividadValidaHastaTimestamp,
      ultimo_punto_conteo: ahoraTimestamp,
      ultimo_heartbeat: ahoraTimestamp,
      tiempo_requerido_ms: requeridoMs,
      tiempo_requerido_minutos: Number(tarea.tiempo_requerido),
      tiempo_activo_valido: Number(realizacionActual.tiempo_activo_valido) || 0,
      tiempo_adicional: Number(realizacionActual.tiempo_adicional) || 0,
      cantidad_heartbeat: 0,
      cantidad_actividades: 0
    };

    tx.set(sesionRef, datosSesion);

    sesionResultado = {
      ref: sesionRef,
      ...datosSesion
    };
  });

  return {
    realizacion,
    sesion: sesionResultado
  };
}

async function manejarActividad(
  uid,
  tarea,
  realizacion
) {
  const sesionRef = db.collection("sesiones_tareas").doc(uid);
  let resultado = null;

  await db.runTransaction(async (tx) => {
    const sesionSnap = await tx.get(sesionRef);
    const realizacionSnap = await tx.get(realizacion.ref);

    if (!sesionSnap.exists || !realizacionSnap.exists) {
      throw new Error("SESION_NO_ENCONTRADA");
    }

    const sesionActual = {
      ref: sesionRef,
      ...sesionSnap.data()
    };

    const realizacionActual = {
      ref: realizacion.ref,
      ...realizacionSnap.data()
    };

    if (sesionActual.activa !== true || sesionActual.realizacion_id !== realizacion.ref.id) {
      throw new Error("SESION_NO_ACTIVA");
    }

    const actividadHasta = timestampMs(sesionActual.actividad_valida_hasta);
    if (!actividadHasta || actividadHasta <= ahoraMs()) {
      throw new Error("SESION_NO_ACTIVA");
    }

    const ahoraTimestamp = ahora();
    const valores =
      calcularNuevoTiempo(
        sesionActual,
        realizacionActual,
        tarea
      );

    registrarTiempoSesion(
      tx,
      sesionRef,
      realizacion.ref,
      valores,
      ahoraTimestamp
    );

    const nuevaActividadHasta =
      Timestamp.fromMillis(
        ahoraMs() +
          ACTIVITY_WINDOW_MS
      );

    tx.update(sesionRef, {
      activa: true,
      ultima_actividad: ahoraTimestamp,
      actividad_valida_hasta: nuevaActividadHasta,
      cantidad_actividades: FieldValue.increment(1)
    });

    tx.update(realizacion.ref, {
      cantidad_actividades:
        FieldValue.increment(1)
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

async function manejarPausa(
  uid,
  tarea,
  realizacion
) {
  const sesionRef = db.collection("sesiones_tareas").doc(uid);

  await db.runTransaction(async (tx) => {
    const sesionSnap = await tx.get(sesionRef);
    const realizacionSnap = await tx.get(realizacion.ref);

    if (!sesionSnap.exists || !realizacionSnap.exists) {
      return;
    }

    const sesionActual = {
      ref: sesionRef,
      ...sesionSnap.data()
    };

    const realizacionActual = {
      ref: realizacion.ref,
      ...realizacionSnap.data()
    };

    if (sesionActual.activa !== true || sesionActual.realizacion_id !== realizacion.ref.id) {
      return;
    }

    const ahoraTimestamp = ahora();
    const valores =
      calcularNuevoTiempo(
        sesionActual,
        realizacionActual,
        tarea
      );

    tx.update(sesionRef, {
      activa: false,
      tiempo_activo_valido: valores.tiempo_activo_valido,
      tiempo_adicional: valores.tiempo_adicional,
      ultimo_punto_conteo: ahoraTimestamp,
      actividad_valida_hasta: ahoraTimestamp
    });

    tx.update(realizacion.ref, {
      tiempo_activo_valido: valores.tiempo_activo_valido,
      tiempo_adicional: valores.tiempo_adicional
    });
  });
}

async function manejarHeartbeat(
  uid,
  realizacion
) {
  const sesionRef = db.collection("sesiones_tareas").doc(uid);

  await db.runTransaction(async (tx) => {
    const sesionSnap =
      await tx.get(sesionRef);

    if (!sesionSnap.exists) {
      throw new Error(
        "SESION_NO_ENCONTRADA"
      );
    }

    const sesionActual = {
      ref: sesionRef,
      ...sesionSnap.data()
    };

    if (sesionActual.activa !== true || sesionActual.realizacion_id !== realizacion.ref.id) {
      throw new Error(
        "SESION_NO_ACTIVA"
      );
    }

    const actividadHasta = timestampMs(sesionActual.actividad_valida_hasta);
    if (!actividadHasta || actividadHasta <= ahoraMs()) {
      throw new Error("SESION_NO_ACTIVA");
    }

    tx.update(sesionRef, {
      ultimo_heartbeat:
        ahora(),

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
  if (realizacion.usuario_id !== uid) {
    throw new Error("NO_AUTORIZADO");
  }

  const vencimientoMs =
    timestampMs(
      realizacion.fecha_vencimiento
    );

  if (
    vencimientoMs &&
    vencimientoMs <= ahoraMs()
  ) {
    await cerrarRealizacionPorCaducidad(
      realizacion.ref,
      "vencimiento_7_dias"
    );

    throw new Error(
      "REALIZACION_VENCIDA"
    );
  }

  const sesionRef = db.collection("sesiones_tareas").doc(uid);
  const sesion =
    await obtenerSesionActual(
      realizacion.ref.id,
      uid
    );

  const ahoraTimestamp = ahora();

  let resultado = null;

  await db.runTransaction(async (tx) => {
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
      realizacionActual.estado !==
      "pendiente"
    ) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    let tiempoActivo =
      Number(
        realizacionActual
          .tiempo_activo_valido
      ) || 0;

    let tiempoAdicional =
      Number(
        realizacionActual
          .tiempo_adicional
      ) || 0;

    if (sesion) {
      const sesionSnap =
        await tx.get(sesionRef);

      if (sesionSnap.exists) {
        const sesionActual = {
          ref: sesionRef,
          ...sesionSnap.data()
        };

        const valores =
          calcularNuevoTiempo(
            sesionActual,
            realizacionActual,
            tarea
          );

        tiempoActivo =
          valores.tiempo_activo_valido;

        tiempoAdicional =
          valores.tiempo_adicional;

        if (
          tiempoActivo <
          obtenerTiempoRequeridoMs(tarea)
        ) {
          registrarTiempoSesion(
            tx,
            sesionRef,
            realizacion.ref,
            valores,
            ahoraTimestamp
          );

          resultado = {
            completada: false,
            tiempo_activo_valido:
              tiempoActivo
          };

          return;
        }

        tx.update(sesionRef, {
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
      }
    }

    if (
      tiempoActivo <
      obtenerTiempoRequeridoMs(tarea)
    ) {
      resultado = {
        completada: false,
        tiempo_activo_valido:
          tiempoActivo
      };

      return;
    }

    const historialRef =
      db.collection(
        "historial_realizaciones"
      ).doc();

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
      tarea_id: tarea.ref.id,

      usuario_id: uid,

      email:
        realizacionActual.email ||
        null,

      titulo_tarea:
        realizacionActual.titulo_tarea ||
        tarea.titulo ||
        null,

      fecha_inicio:
        realizacionActual.fecha_inicio ||
        null,

      fecha_vencimiento:
        realizacionActual
          .fecha_vencimiento ||
        null,

      fecha_cierre:
        ahoraTimestamp,

      fecha_completada:
        ahoraTimestamp,

      estado_final:
        "completada",

      tiempo_activo_valido:
        tiempoActivo,

      tiempo_adicional:
        tiempoAdicional
    });

    const progresoRef =
      db.collection(
        "progreso_tareas"
      ).doc();

    tx.set(progresoRef, {
      email:
        realizacionActual.email ||
        null,

      fecha_realizada:
        ahoraTimestamp,

      minutos_realizados:
        minutosCompletos(
          tiempoActivo
        ),

      tarea_id: tarea.ref.id,

      usuario_id: uid,

      veces_realizada: 1,

      titulo_tarea:
        realizacionActual
          .titulo_tarea ||
        tarea.titulo ||
        null
    });

    const estadisticasRef =
      db.collection(
        "estadisticas_usuario"
      ).doc(uid);

    const estadisticasSnap =
      await tx.get(
        estadisticasRef
      );

    const fechaArgentina =
      obtenerFechaArgentina();

    if (estadisticasSnap.exists) {
      const estadisticas =
        estadisticasSnap.data();

      const ultimaFecha =
        timestampMs(
          estadisticas
            .ultima_fecha_trabajo
        );

      const fechaUltimaArgentina =
        ultimaFecha
          ? obtenerFechaArgentina(
              ultimaFecha
            )
          : null;

      const mismoDia =
        fechaUltimaArgentina ===
        fechaArgentina;

      tx.update(estadisticasRef, {
        email:
          estadisticas.email ||
          realizacionActual.email ||
          null,

        minutos_acumulados:
          FieldValue.increment(
            minutosCompletos(
              tiempoActivo
            )
          ),

        tareas_realizadas:
          FieldValue.increment(1),

        dias_trabajados:
          mismoDia
            ? Number(
                estadisticas
                  .dias_trabajados || 0
              )
            : FieldValue.increment(1),

        ultima_fecha_trabajo:
          ahoraTimestamp,

        usuario_id: uid
      });
    } else {
      tx.set(estadisticasRef, {
        email:
          realizacionActual.email ||
          null,

        minutos_acumulados:
          minutosCompletos(
            tiempoActivo
          ),

        tareas_realizadas: 1,

        dias_trabajados: 1,

        ultima_fecha_trabajo:
          ahoraTimestamp,

        usuario_id: uid
      });
    }

    resultado = {
      completada: true,

      tiempo_activo_valido:
        tiempoActivo
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

function obtenerFechaArgentina(
  fechaMs = ahoraMs()
) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).format(
    new Date(fechaMs)
  );
}

async function obtenerEstado(
  uid,
  usuario,
  tarea
) {
  if (!faseCoincide(usuario, tarea)) {
    throw new Error(
      "TAREA_NO_CORRESPONDE"
    );
  }

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

    if (
      vencimientoMs &&
      vencimientoMs <= ahoraMs()
    ) {
      await cerrarRealizacionPorCaducidad(
        realizacion.ref,
        "vencimiento_7_dias"
      );

      realizacion = null;
    }
  }

  if (
    !realizacion &&
    tareaRetirada(tarea)
  ) {
    throw new Error(
      "TAREA_NO_DISPONIBLE"
    );
  }

  let sesion = null;
  let calculado = null;

  if (realizacion) {
    sesion =
      await obtenerSesionActual(
        realizacion.ref.id,
        uid
      );

    if (sesion) {
      calculado =
        calcularNuevoTiempo(
          sesion,
          realizacion,
          tarea
        );
    }
  }

  return {
    tarea: tareaPublica(tarea),

    realizacion: realizacion
      ? realizacionPublica({
          ...realizacion,

          ...(calculado
            ? {
                tiempo_activo_valido:
                  calculado
                    .tiempo_activo_valido
              }
            : {})
        })
      : null,

    sesion: sesion
      ? sesionPublica(
          sesion,
          calculado
        )
      : null
  };
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
      "El usuario está inactivo."
    ],

    TAREA_ID_REQUERIDO: [
      400,
      "Falta el identificador de la tarea."
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
      "No se encontró la tarea."
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
    ]
  };

  const clave =
    error && error.message
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

    let tareaId;
    let accion = null;

    if (req.method === "GET") {
      tareaId = req.query?.id;
      accion = "estado";
    } else {
      tareaId =
        req.body?.tarea_id;

      accion =
        req.body?.accion;
    }

    const tarea =
      await obtenerTarea(tareaId);

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

    const realizacion =
      await obtenerRealizacionUsuario(
        tarea.ref.id,
        uid
      );

    if (!realizacion) {
      throw new Error(
        "REALIZACION_NO_DISPONIBLE"
      );
    }

    const vencimientoMs =
      timestampMs(
        realizacion.fecha_vencimiento
      );

    if (
      vencimientoMs &&
      vencimientoMs <= ahoraMs()
    ) {
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
          resultado.tiempo_activo_valido
      });
    }

    if (accion === "pausa") {
      await manejarPausa(
        uid,
        tarea,
        realizacion
      );

      return respuesta(res, 200, {
        ok: true
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
          resultado.tiempo_activo_valido
      });
    }

    return respuesta(res, 405, {
      ok: false,
      error: "ACCION_NO_VALIDA"
    });
  } catch (error) {
    const [status, mensaje] =
      mensajeError(error);

    return respuesta(res, status, {
      ok: false,
      error:
        error?.message ||
        "ERROR_INTERNO",
      mensaje
    });
  }
};
