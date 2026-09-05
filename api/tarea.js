const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}

const authAdmin = getAuth();
const db = getFirestore();

async function verificarUsuario(req) {
  const autorizacion = req.headers.authorization || "";

  if (!autorizacion.startsWith("Bearer ")) {
    throw new Error("No autorizado");
  }

  const token = autorizacion.substring(7);

  return await authAdmin.verifyIdToken(token);
}

async function obtenerDatos(uid, tareaId) {
  const usuarioSnap =
    await db.collection("users").doc(uid).get();

  if (!usuarioSnap.exists) {
    throw new Error("Usuario no encontrado");
  }

  const usuario = usuarioSnap.data();

  if (usuario.activo !== true) {
    throw new Error("Usuario inactivo");
  }

  const tareaSnap =
    await db.collection("tareas").doc(tareaId).get();

  if (!tareaSnap.exists) {
    throw new Error("Tarea no encontrada");
  }

  const tarea = tareaSnap.data();

  if (tarea.activa !== true) {
    throw new Error("Tarea inactiva");
  }

  if (
    String(tarea.fase || "") !==
    String(usuario.fase || "")
  ) {
    throw new Error("Tarea no disponible");
  }

  return {
    tarea
  };
}

module.exports = async function handler(req, res) {
  try {
    const usuarioAutenticado =
      await verificarUsuario(req);

    const uid =
      usuarioAutenticado.uid;

    if (req.method === "GET") {
      const tareaId =
        String(req.query.id || "").trim();

      if (!tareaId) {
        return res.status(400).json({
          ok: false,
          error: "No se especificó la tarea."
        });
      }

      const { tarea } =
        await obtenerDatos(uid, tareaId);

      const sesionId =
        `${uid}_${tareaId}`;

      const sesionRef =
        db.collection("sesiones_tareas")
          .doc(sesionId);

      const sesionSnap =
        await sesionRef.get();

      let tiempoAcumulado = 0;
      let activa = false;
      let inicioActual = null;

      if (sesionSnap.exists) {
        const sesion =
          sesionSnap.data();

        tiempoAcumulado =
          Number(
            sesion.tiempo_acumulado || 0
          );

        activa =
          sesion.activa === true;

        if (sesion.inicio_actual) {
          inicioActual =
            sesion.inicio_actual.toMillis();
        }

        if (activa && inicioActual) {
          tiempoAcumulado +=
            Math.max(
              0,
              Date.now() - inicioActual
            );
        }
      }

      const tiempoRequerido =
        Number(
          tarea.tiempo_requerido || 0
        ) * 60 * 1000;

      tiempoAcumulado =
        Math.min(
          tiempoAcumulado,
          tiempoRequerido
        );

      return res.status(200).json({
        ok: true,

        tarea: {
          id: tareaId,
          titulo: tarea.titulo || "",
          descripcion: tarea.descripcion || "",
          tiempo_requerido:
            Number(
              tarea.tiempo_requerido || 0
            )
        },

        sesion: {
          tiempo_acumulado:
            tiempoAcumulado,
          activa
        }
      });
    }

    if (req.method === "POST") {
      const tareaId =
        String(
          req.body?.tarea_id || ""
        ).trim();

      const accion =
        String(
          req.body?.accion || ""
        ).trim();

      if (!tareaId || !accion) {
        return res.status(400).json({
          ok: false,
          error: "Solicitud incompleta."
        });
      }

      const { tarea } =
        await obtenerDatos(uid, tareaId);

      const sesionId =
        `${uid}_${tareaId}`;

      const sesionRef =
        db.collection("sesiones_tareas")
          .doc(sesionId);

      const sesionSnap =
        await sesionRef.get();

      let tiempoAcumulado = 0;
      let inicioActual = null;
      let activa = false;

      if (sesionSnap.exists) {
        const sesion =
          sesionSnap.data();

        tiempoAcumulado =
          Number(
            sesion.tiempo_acumulado || 0
          );

        inicioActual =
          sesion.inicio_actual || null;

        activa =
          sesion.activa === true;
      }

      const tiempoRequerido =
        Number(
          tarea.tiempo_requerido || 0
        ) * 60 * 1000;

      if (accion === "iniciar") {
        if (!activa) {
          await sesionRef.set(
            {
              usuario_id: uid,
              tarea_id: tareaId,
              tiempo_acumulado:
                tiempoAcumulado,
              activa: true,
              inicio_actual:
                FieldValue.serverTimestamp(),
              actualizado:
                FieldValue.serverTimestamp()
            },
            { merge: true }
          );
        }

        return res.status(200).json({
          ok: true,
          activa: true,
          tiempo_acumulado:
            tiempoAcumulado
        });
      }

      if (accion === "pausar") {
        if (activa && inicioActual) {
          tiempoAcumulado +=
            Math.max(
              0,
              Date.now() -
              inicioActual.toMillis()
            );
        }

        tiempoAcumulado =
          Math.min(
            tiempoAcumulado,
            tiempoRequerido
          );

        await sesionRef.set(
          {
            usuario_id: uid,
            tarea_id: tareaId,
            tiempo_acumulado:
              tiempoAcumulado,
            activa: false,
            inicio_actual: null,
            actualizado:
              FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return res.status(200).json({
          ok: true,
          activa: false,
          tiempo_acumulado:
            tiempoAcumulado
        });
      }

      if (accion === "completar") {
        if (activa && inicioActual) {
          tiempoAcumulado +=
            Math.max(
              0,
              Date.now() -
              inicioActual.toMillis()
            );
        }

        tiempoAcumulado =
          Math.min(
            tiempoAcumulado,
            tiempoRequerido
          );

        if (
          tiempoAcumulado <
          tiempoRequerido
        ) {
          await sesionRef.set(
            {
              usuario_id: uid,
              tarea_id: tareaId,
              tiempo_acumulado:
                tiempoAcumulado,
              activa: false,
              inicio_actual: null,
              actualizado:
                FieldValue.serverTimestamp()
            },
            { merge: true }
          );

          return res.status(400).json({
            ok: false,
            error:
              "Todavía no cumpliste el tiempo requerido.",
            tiempo_acumulado:
              tiempoAcumulado
          });
        }

        const progresoRef =
          db.collection("progreso_tareas")
            .doc(`${uid}_${tareaId}`);

        const estadisticasRef =
          db.collection("estadisticas_usuario")
            .doc(uid);

        const ahora =
          new Date();

        await db.runTransaction(
          async (transaction) => {

            const progresoSnap =
              await transaction.get(
                progresoRef
              );

            const estadisticasSnap =
              await transaction.get(
                estadisticasRef
              );

            if (progresoSnap.exists) {
              transaction.update(
                progresoRef,
                {
                  veces_realizada:
                    FieldValue.increment(1),

                  fecha_realizada:
                    FieldValue.serverTimestamp(),

                  titulo_tarea:
                    tarea.titulo || "",

                  minutos_realizados:
                    FieldValue.increment(
                      Number(
                        tarea.tiempo_requerido || 0
                      )
                    )
                }
              );
            } else {
              transaction.set(
                progresoRef,
                {
                  usuario_id: uid,
                  tarea_id: tareaId,
                  titulo_tarea:
                    tarea.titulo || "",
                  fecha_realizada:
                    FieldValue.serverTimestamp(),
                  veces_realizada: 1,
                  minutos_realizados:
                    Number(
                      tarea.tiempo_requerido || 0
                    )
                }
              );
            }

            if (!estadisticasSnap.exists) {
              transaction.set(
                estadisticasRef,
                {
                  usuario_id: uid,
                  tareas_realizadas: 1,
                  minutos_acumulados:
                    Number(
                      tarea.tiempo_requerido || 0
                    ),
                  dias_trabajados: 1,
                  ultima_fecha_trabajo:
                    FieldValue.serverTimestamp()
                }
              );
            } else {
              const datos =
                estadisticasSnap.data();

              let sumarDia = false;

              if (!datos.ultima_fecha_trabajo) {
                sumarDia = true;
              } else {
                const ultima =
                  datos.ultima_fecha_trabajo.toDate();

                if (
                  ultima.getFullYear() !==
                    ahora.getFullYear() ||
                  ultima.getMonth() !==
                    ahora.getMonth() ||
                  ultima.getDate() !==
                    ahora.getDate()
                ) {
                  sumarDia = true;
                }
              }

              const actualizacion = {
                tareas_realizadas:
                  FieldValue.increment(1),

                minutos_acumulados:
                  FieldValue.increment(
                    Number(
                      tarea.tiempo_requerido || 0
                    )
                  ),

                ultima_fecha_trabajo:
                  FieldValue.serverTimestamp()
              };

              if (sumarDia) {
                actualizacion.dias_trabajados =
                  FieldValue.increment(1);
              }

              transaction.update(
                estadisticasRef,
                actualizacion
              );
            }

            transaction.set(
              sesionRef,
              {
                usuario_id: uid,
                tarea_id: tareaId,

                tiempo_acumulado: 0,

                activa: false,
                inicio_actual: null,

                completada: true,

                fecha_completada:
                  FieldValue.serverTimestamp(),

                actualizado:
                  FieldValue.serverTimestamp()
              },
              { merge: true }
            );
          }
        );

        return res.status(200).json({
          ok: true,
          completada: true
        });
      }

      return res.status(400).json({
        ok: false,
        error: "Acción no válida."
      });
    }

    return res.status(405).json({
      ok: false,
      error: "Método no permitido."
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "No se pudo procesar la tarea."
    });
  }
};
