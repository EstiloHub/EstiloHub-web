const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");


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

      projectId:
        process.env.FIREBASE_PROJECT_ID,

      clientEmail:
        process.env.FIREBASE_CLIENT_EMAIL,

      privateKey:
        privateKey

    })

  });

}


function convertirFecha(valor) {

  if (!valor) {
    return null;
  }


  if (
    typeof valor.toDate === "function"
  ) {

    return valor
      .toDate()
      .toISOString();

  }


  return valor;

}


module.exports = async function handler(req, res) {

  if (req.method !== "GET") {

    return res.status(405).json({

      ok: false,

      error:
        "Método no permitido."

    });

  }


  try {

    getFirebaseAdmin();


    const auth =
      getAuth();

    const db =
      getFirestore();


    const authorization =
      req.headers.authorization || "";


    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {

      return res.status(401).json({

        ok: false,

        error:
          "No autorizado."

      });

    }


    const idToken =
      authorization
        .substring(7)
        .trim();


    if (!idToken) {

      return res.status(401).json({

        ok: false,

        error:
          "No autorizado."

      });

    }


    let usuarioAutenticado;


    try {

      usuarioAutenticado =
        await auth.verifyIdToken(
          idToken
        );

    } catch (error) {

      return res.status(401).json({

        ok: false,

        error:
          "La sesión no es válida."

      });

    }


    const uid =
      usuarioAutenticado.uid;


    const usuarioRef =
      db
        .collection("users")
        .doc(uid);


    const estadisticasRef =
      db
        .collection(
          "estadisticas_usuario"
        )
        .doc(uid);


    const [
      usuarioSnap,
      estadisticasSnap
    ] = await Promise.all([

      usuarioRef.get(),

      estadisticasRef.get()

    ]);


    if (!usuarioSnap.exists) {

      return res.status(404).json({

        ok: false,

        error:
          "No se encontró el usuario."

      });

    }


    const usuario =
      usuarioSnap.data();


    if (
      usuario.activo === false
    ) {

      return res.status(403).json({

        ok: false,

        error:
          "La cuenta no está activa."

      });

    }


    const faseUsuario =
      String(
        usuario.fase ||
        "Fase 1"
      ).trim();


    const estadisticas =
      estadisticasSnap.exists
        ? estadisticasSnap.data()
        : {};


    const tareasSnapshot =
      await db
        .collection("tareas")
        .where(
          "activa",
          "==",
          true
        )
        .get();


    const tareas = [];


    tareasSnapshot.forEach(
      (documento) => {

        const datos =
          documento.data();


        const faseTarea =
          String(
            datos.fase ?? ""
          ).trim();


        const correspondeFase =
          faseTarea === faseUsuario ||

          (
            faseTarea === "1" &&
            faseUsuario === "Fase 1"
          ) ||

          (
            faseTarea === "Fase 1" &&
            faseUsuario === "1"
          );


        if (!correspondeFase) {
          return;
        }


        tareas.push({

          id:
            documento.id,

          categoria:
            String(
              datos.categoria || ""
            ),

          titulo:
            String(
              datos.titulo || ""
            ),

          descripcion:
            String(
              datos.descripcion || ""
            ),

          tiempo_requerido:
            Number(
              datos.tiempo_requerido || 0
            ),

          link_url:
            String(
              datos.link_url || ""
            ),

          orden:
            Number.isFinite(
              Number(datos.orden)
            )
              ? Number(datos.orden)
              : 999999

        });

      }
    );


    tareas.sort(
      (a, b) => {

        if (
          a.orden !== b.orden
        ) {

          return (
            a.orden -
            b.orden
          );

        }


        return a.titulo.localeCompare(
          b.titulo,
          "es"
        );

      }
    );


    const progresoSnapshot =
      await db
        .collection(
          "progreso_tareas"
        )
        .where(
          "usuario_id",
          "==",
          uid
        )
        .get();


    const progreso = {};


    progresoSnapshot.forEach(
      (documento) => {

        const datos =
          documento.data();


        if (!datos.tarea_id) {
          return;
        }


        progreso[
          datos.tarea_id
        ] = {

          fecha_realizada:
            convertirFecha(
              datos.fecha_realizada
            ),

          minutos_realizados:
            Number(
              datos.minutos_realizados || 0
            ),

          veces_realizada:
            Number(
              datos.veces_realizada || 0
            )

        };

      }
    );


    const tareasParaCliente =
      tareas.map(
        (tarea) => {

          const datosProgreso =
            progreso[tarea.id] || {};


          return {

            id:
              tarea.id,

            categoria:
              tarea.categoria,

            titulo:
              tarea.titulo,

            descripcion:
              tarea.descripcion,

            tiempo_requerido:
              tarea.tiempo_requerido,

            link_url:
              tarea.link_url,

            fecha_realizada:
              datosProgreso
                .fecha_realizada ||
              null,

            minutos_realizados:
              datosProgreso
                .minutos_realizados ||
              0,

            veces_realizada:
              datosProgreso
                .veces_realizada ||
              0

          };

        }
      );


    return res.status(200).json({

      ok: true,

      usuario: {

        fase:
          faseUsuario

      },

      admin:
        usuarioAutenticado.admin === true,

      estadisticas: {

        tareas_realizadas:
          Number(
            estadisticas
              .tareas_realizadas ||
            0
          ),

        dias_trabajados:
          Number(
            estadisticas
              .dias_trabajados ||
            0
          ),

        minutos_acumulados:
          Number(
            estadisticas
              .minutos_acumulados ||
            0
          )

      },

      tareas:
        tareasParaCliente

    });


  } catch (error) {

    return res.status(500).json({

      ok: false,

      error:
        error?.message ||
        "Error interno del servidor."

    });

  }

};
