/* ============================================================================
   VisitaFlow - Pantallas del sistema

   Cada pantalla se registra con VF.registrarRuta(nombre, { titulo, permiso,
   pintar(contenedor, parametros) }). El router se encarga del resto.

   Regla que se sigue en todas: la pantalla dice que hacer cuando no hay datos,
   y nunca deja un hueco en blanco.
   ============================================================================ */

VF.paginas = VF.paginas || {};

/* ============================================================================
   ACCESO
   ============================================================================ */

VF.paginas.acceso = function (contenedor) {
  contenedor.innerHTML = VF.ui.cargando();

  (async function () {
    let instituciones = [];
    let estadoInicial = null;

    /* Se pregunta en paralelo por las instituciones y por el estado inicial.
       Lo segundo es lo que dice si la instalación está VACÍA: en un despliegue
       nuevo, sin licencia, no aparecería ninguna institución y sin esto la
       pantalla se quedaría sin salida. */
    try {
      const r = await VF.api.get('/api/acceso/instituciones', { sinRedirigir: true });
      instituciones = r.instituciones || [];
    } catch (e) {
      contenedor.innerHTML =
        '<div class="acceso"><div class="acceso__caja"><div class="aviso aviso--peligro">' +
        VF.icono.svg('alerta') + '<div><strong>No hay conexión con el sistema</strong><div>' +
        VF.ui.esc(e.message) + '</div></div></div></div></div>';
      return;
    }

    try {
      estadoInicial = await VF.api.get('/api/licencia/estado-inicial', { sinRedirigir: true });
    } catch (e) {
      estadoInicial = null;
    }

    if (!instituciones.length) {
      const vacia = !estadoInicial || estadoInicial.primer_arranque !== false;
      mostrarSinInstitucion(vacia);
      return;
    }

    // Si solo hay una institucion, no se pregunta cual: se asume.
    const unica = instituciones.length === 1 ? instituciones[0] : null;
    pintarFormulario(unica);

    function pintarFormulario(institucion) {
      const marca = institucion || null;
      const nombre = marca ? marca.nombre_comercial || marca.nombre : 'VisitaFlow';
      const ini = VF.ui.iniciales(nombre);

      contenedor.innerHTML =
        '<div class="acceso"><div class="acceso__caja">' +
        '<div class="acceso__marca">' +
        '<div class="acceso__logo">' + (marca && marca.logo_url ? '<img src="' + VF.ui.esc(marca.logo_url) + '" alt="">' : VF.ui.esc(ini)) + '</div>' +
        '<div class="acceso__titulo">' + VF.ui.esc(nombre) + '</div>' +
        '<div class="acceso__sub">Sistema de registro y control de visitantes</div>' +
        '</div>' +
        '<div class="tarjeta"><div class="tarjeta__cuerpo">' +
        '<form id="forma-acceso" novalidate>' +
        /* No se pregunta la institución: esta instalación es de un solo cliente y
           el servidor la resuelve con su licencia. El recepcionista solo escribe
           su correo y su contraseña. */
        '<div class="campo"><label class="campo__etiqueta" for="correo">Correo</label>' +
        '<input class="entrada" type="email" id="correo" autocomplete="username" required autofocus></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="clave">Contraseña</label>' +
        '<input class="entrada" type="password" id="clave" autocomplete="current-password" required></div>' +
        '<div id="error-acceso" hidden></div>' +
        '<button class="boton boton--bloque boton--grande" type="submit" id="entrar">Entrar</button>' +
        '</form>' +
        '<div class="texto-centro mt-2"><a href="#" id="olvide" class="texto-chico">Olvidé mi contraseña</a></div>' +
        '</div></div>' +
        '<div class="acceso__pie">VisitaFlow · sistema local, funciona sin Internet</div>' +
        '</div></div>';

      const forma = document.getElementById('forma-acceso');
      const boton = document.getElementById('entrar');

      forma.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const error = document.getElementById('error-acceso');
        error.hidden = true;
        boton.disabled = true;
        boton.textContent = 'Entrando…';

        try {
          const r = await VF.api.post('/api/acceso/entrar', {
            correo: document.getElementById('correo').value,
            clave: document.getElementById('clave').value,
          });
          VF.api.guardarToken(r.token);
          VF.estado.usuario = r.usuario;
          VF.estado.permisos = r.permisos;
          VF.estado.licencia = r.licencia;
          VF.aplicarMarca(r.marca);
          location.hash = '#/panel';
          location.reload();
        } catch (e) {
          error.hidden = false;
          error.className = 'aviso aviso--peligro';
          error.innerHTML = VF.icono.svg('alerta') + '<div>' + VF.ui.esc(e.message) + '</div>';
          boton.disabled = false;
          boton.textContent = 'Entrar';
          document.getElementById('clave').select();
        }
      });

      document.getElementById('olvide').addEventListener('click', async (ev) => {
        ev.preventDefault();
        const correo = document.getElementById('correo').value.trim();
        if (!correo) {
          document.getElementById('correo').focus();
          VF.ui.aviso('aviso', 'Escriba su correo', 'Necesitamos su correo para enviarle el enlace.');
          return;
        }
        try {
          // El servidor resuelve la institución con su licencia.
          const r = await VF.api.post('/api/acceso/recuperar', { correo }, { sinRedirigir: true });
          VF.ui.aviso('info', 'Revise su correo', r.mensaje);
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo procesar', e.message);
        }
      });
    }

    /**
     * Instalación sin ninguna institución: es un despliegue nuevo.
     *
     * Se muestra el formulario de activación directamente, sin un botón
     * intermedio: es lo único que se puede hacer aquí, y así el primer arranque
     * se resuelve en un paso.
     */
    function mostrarSinInstitucion(esNueva) {
      contenedor.innerHTML =
        '<div class="acceso"><div class="acceso__caja">' +
        '<div class="acceso__marca">' +
        '<div class="acceso__logo">' + VF.icono.svg('llave', { tamano: 26 }) + '</div>' +
        '<div class="acceso__titulo">' + (esNueva ? 'Activar el sistema' : 'Sin institución activa') + '</div>' +
        '<div class="acceso__sub">' +
        (esNueva
          ? 'Esta instalación todavía no tiene licencia'
          : 'Hay una licencia cargada, pero ninguna institución activa') +
        '</div></div>' +
        '<div class="tarjeta"><div class="tarjeta__cuerpo">' +
        (esNueva
          ? '<p class="texto-chico texto-suave">Pegue el contenido del archivo de licencia que le entregó su proveedor. ' +
            'Se verifica la firma antes de activarlo: si el archivo fue modificado, se rechaza.</p>'
          : '<div class="aviso aviso--aviso">' + VF.icono.svg('alerta') +
            '<div class="texto-chico">La licencia no permitió crear la institución. Puede volver a activarla con un archivo válido.</div></div>') +
        '<div class="campo"><label class="campo__etiqueta" for="archivo-lic">Archivo de licencia (.vflow)</label>' +
        '<input class="entrada" type="file" id="archivo-lic" accept=".vflow,.txt">' +
        '<div class="campo__ayuda">O pegue el contenido abajo.</div></div>' +
        '<div class="campo"><textarea class="area entrada--mono" id="texto-lic" rows="7" ' +
        'placeholder="-----BEGIN VISITAFLOW LICENSE-----"></textarea></div>' +
        '<div id="error-lic" hidden></div>' +
        '<button class="boton boton--bloque boton--grande" id="activar-lic">Activar</button>' +
        '</div></div>' +
        '<div class="acceso__pie">VisitaFlow · el sistema funciona sin Internet una vez activado</div>' +
        '</div></div>';

      document.getElementById('archivo-lic').addEventListener('change', (ev) => {
        const f = ev.target.files[0];
        if (!f) return;
        const lector = new FileReader();
        lector.onload = () => { document.getElementById('texto-lic').value = lector.result; };
        lector.readAsText(f);
      });

      document.getElementById('activar-lic').addEventListener('click', async () => {
        const texto = document.getElementById('texto-lic').value.trim();
        const error = document.getElementById('error-lic');
        const boton = document.getElementById('activar-lic');
        error.hidden = true;

        if (!texto) {
          error.hidden = false;
          error.className = 'aviso aviso--aviso';
          error.innerHTML = VF.icono.svg('alerta') + '<div>Pegue el contenido de la licencia.</div>';
          return;
        }

        boton.disabled = true;
        boton.textContent = 'Activando…';
        try {
          await VF.api.post('/api/licencia/activar', { texto }, { sinRedirigir: true });
          VF.ui.aviso('exito', 'Licencia activada', 'La institución quedó creada. Ya puede entrar con su usuario.');
          // Las credenciales del administrador las deja el servidor al arrancar.
          setTimeout(() => location.reload(), 1200);
        } catch (e) {
          error.hidden = false;
          error.className = 'aviso aviso--peligro';
          error.innerHTML = VF.icono.svg('alerta') + '<div><strong>No se pudo activar</strong><div>' +
            VF.ui.esc(e.message) + '</div></div>';
          boton.disabled = false;
          boton.textContent = 'Activar';
        }
      });
    }
  })();
};

/* ============================================================================
   PANEL
   ============================================================================ */

VF.registrarRuta('panel', {
  titulo: 'Panel',
  permiso: 'recepcion.ver',
  async pintar(cont) {
    const r = await VF.api.get('/api/panel');
    const p = r.panel;
    const m = p.metricas;

    VF.barra.establecerInsignias({ dentro: m.dentro, preregistros: m.preregistros, bloqueados: m.bloqueados });

    VF.cabecera(
      'Buen día',
      VF.ui.fecha(new Date().toISOString(), true) + ' · ' + (VF.estado.usuario ? VF.estado.usuario.nombre : ''),
      VF.tiene('registro.crear')
        ? '<button class="boton boton--grande" id="nueva-visita">' + VF.icono.svg('registro') + 'Registrar visita</button>'
        : ''
    );

    const alerta = [];
    if (m.largas > 0) {
      alerta.push(
        '<div class="aviso aviso--aviso">' + VF.icono.svg('reloj') +
        '<div class="crecer"><strong>' + m.largas + ' visita(s) llevan más de ' + p.minutos_alerta + ' minutos dentro.</strong>' +
        '<div>Puede que se hayan ido sin registrar la salida.</div></div>' +
        '<button class="boton boton--secundario boton--chico" id="ver-largas">Ver</button></div>'
      );
    }
    if (m.sin_aprobar > 0) {
      alerta.push(
        '<div class="aviso aviso--aviso">' + VF.icono.svg('alerta') +
        '<div class="crecer"><strong>' + m.sin_aprobar + ' visita(s) esperan aprobación.</strong></div>' +
        '<button class="boton boton--secundario boton--chico" id="ver-sin-aprobar">Ver</button></div>'
      );
    }
    if (m.bloqueados > 0) {
      alerta.push(
        '<div class="aviso aviso--info">' + VF.icono.svg('escudo') +
        '<div class="crecer">Hay <strong>' + m.bloqueados + '</strong> cédula(s) bloqueada(s) en la lista de vigilancia.</div></div>'
      );
    }

    cont.innerHTML =
      alerta.join('') +
      '<div class="rejilla rejilla--metricas mb-3">' +
      metrica('Dentro ahora', m.dentro, 'personas en las instalaciones', 'bien') +
      metrica('Entradas de hoy', m.hoy, 'registradas hoy') +
      metrica('Salidas de hoy', m.salidas_hoy, 'con salida registrada') +
      metrica(
        'Visitas anunciadas',
        m.preregistros,
        'pendientes de llegar',
        m.preregistros > 0 ? 'info' : ''
      ) +
      metrica('Sin aprobar', m.sin_aprobar, 'esperando autorización', m.sin_aprobar > 0 ? 'alerta' : '') +
      metrica('Visitas largas', m.largas, 'más de ' + p.minutos_alerta + ' min', m.largas > 0 ? 'alerta' : '') +
      '</div>' +

      '<div class="rejilla rejilla--panel">' +
      '<div class="tarjeta">' +
      '<div class="tarjeta__cabecera"><h2>Últimos movimientos</h2>' +
      '<a class="boton boton--secundario boton--chico" href="#/bitacora">Ver bitácora</a></div>' +
      (p.recientes.length ? tablaRecientes(p.recientes) : VF.ui.vacio({
        titulo: 'Todavía no hay movimientos hoy',
        texto: 'Cuando registre la primera visita, aparecerá aquí.',
        icono: 'registro',
      })) +
      '</div>' +

      '<div class="tarjeta">' +
      '<div class="tarjeta__cabecera"><h2>Dentro de las instalaciones</h2>' +
      '<span class="etiqueta etiqueta--dentro">' + m.dentro + '</span></div>' +
      (p.dentro_detalle.length ? listaDentro(p.dentro_detalle) : VF.ui.vacio({
        titulo: 'No hay visitantes dentro',
        texto: 'Las personas que registren entrada aparecerán en esta lista.',
        icono: 'personas',
      })) +
      '</div>' +
      '</div>';

    function metrica(etiqueta, valor, nota, tipo) {
      return (
        '<div class="metrica ' + (tipo ? 'metrica--' + tipo : '') + '">' +
        '<div class="metrica__etiqueta">' + VF.ui.esc(etiqueta) + '</div>' +
        '<div class="metrica__valor">' + VF.ui.esc(valor) + '</div>' +
        '<div class="metrica__nota">' + VF.ui.esc(nota) + '</div>' +
        '</div>'
      );
    }

    function tablaRecientes(filas) {
      return (
        '<div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
        '<th>Visitante</th><th>Destino</th><th>Entrada</th><th>Estado</th><th></th>' +
        '</tr></thead><tbody>' +
        filas
          .map(
            (v) =>
              '<tr>' +
              '<td><div class="tabla__principal">' + VF.ui.esc(v.nombre || '—') + '</div>' +
              '<div class="tabla__secundario">' + VF.ui.esc(v.cedula ? formatearCedula(v.cedula) : 'sin cédula') + '</div></td>' +
              '<td><div>' + VF.ui.esc(v.departamento || '—') + '</div>' +
              '<div class="tabla__secundario">' + VF.ui.esc(v.visitado || '') + '</div></td>' +
              '<td class="texto-chico">' + VF.ui.esc(VF.ui.hora(v.entrada)) + '</td>' +
              '<td>' + VF.ui.estadoVisita(v.estado, v.requiere_aprobacion, v.aprobada) + '</td>' +
              '<td class="texto-derecha">' +
              (v.estado === 'dentro' && VF.tiene('recepcion.salida')
                ? '<button class="boton boton--secundario boton--chico" data-salida="' + v.id + '">Salida</button>'
                : '') +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>'
      );
    }

    function listaDentro(filas) {
      return (
        '<div class="tabla-envoltura"><table class="tabla tabla--compacta"><tbody>' +
        filas
          .map(
            (v) =>
              '<tr>' +
              '<td><div class="tabla__principal">' + VF.ui.esc(v.nombre || '—') + '</div>' +
              '<div class="tabla__secundario">' + VF.ui.esc(v.departamento || '') +
              (v.visitado ? ' · ' + VF.ui.esc(v.visitado) : '') + '</div></td>' +
              '<td class="texto-chico texto-derecha">' +
              (v.larga
                ? '<span class="etiqueta etiqueta--pendiente">' + VF.ui.esc(v.tiempo_dentro) + '</span>'
                : VF.ui.esc(v.tiempo_dentro || '')) +
              '<div class="tabla__secundario">' + VF.ui.esc(VF.ui.hora(v.entrada)) + '</div></td>' +
              '<td class="texto-derecha">' +
              (VF.tiene('recepcion.salida')
                ? '<button class="boton boton--secundario boton--chico" data-salida="' + v.id + '" title="Registrar salida">' +
                  VF.icono.svg('salida') + '</button>'
                : '') +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div>'
      );
    }

    // Acciones de la pantalla.
    const nueva = document.getElementById('nueva-visita');
    if (nueva) nueva.addEventListener('click', () => VF.ir('registro'));

    const verLargas = document.getElementById('ver-largas');
    if (verLargas) verLargas.addEventListener('click', () => VF.ir('dentro', { largas: '1' }));

    const verSinAprobar = document.getElementById('ver-sin-aprobar');
    if (verSinAprobar) verSinAprobar.addEventListener('click', () => VF.ir('dentro', { sin_aprobar: '1' }));

    cont.addEventListener('click', async (ev) => {
      const boton = ev.target.closest('[data-salida]');
      if (!boton) return;
      await VF.paginas.registrarSalida(boton.dataset.salida, () => VF.repintar());
    });
  },
});

/** Formatea una cedula como 001-0000001-7. */
function formatearCedula(cedula) {
  const d = String(cedula || '').replace(/\D/g, '');
  if (d.length !== 11) return cedula || '';
  return d.slice(0, 3) + '-' + d.slice(3, 10) + '-' + d.slice(10);
}

/* ============================================================================
   REGISTRO DE VISITA
   ============================================================================ */

VF.registrarRuta('registro', {
  titulo: 'Registrar visita',
  permiso: 'registro.crear',
  async pintar(cont, params) {
    VF.cabecera('Registrar visita', 'Escriba la cédula y el sistema completa el resto');

    cont.innerHTML =
      '<div class="registro">' +
      '<div>' +
      '<div class="tarjeta mb-2"><div class="tarjeta__cuerpo">' +
      '<div class="campo mb-0">' +
      '<label class="campo__etiqueta" for="cedula">Cédula del visitante <span class="req">*</span></label>' +
      '<div class="campo-cedula">' +
      '<input class="entrada entrada--grande" id="cedula" inputmode="numeric" autocomplete="off" ' +
      'placeholder="001-0000001-7" maxlength="13" autofocus>' +
      '<button class="boton boton--grande" id="consultar">' + VF.icono.svg('buscar') + 'Consultar</button>' +
      '</div>' +
      '<div class="campo__ayuda">Con o sin guiones. Si no la tiene a mano, ' +
      '<a href="#" id="buscar-nombre">busque por nombre</a>.</div>' +
      '</div>' +
      '<div id="resultado-consulta"></div>' +
      '</div></div>' +
      '<form id="forma-registro" class="tarjeta" hidden><div class="tarjeta__cuerpo" id="cuerpo-forma"></div>' +
      '<div class="tarjeta__pie barra-acciones barra-acciones--fin">' +
      '<button class="boton boton--secundario" type="button" id="limpiar">Limpiar</button>' +
      '<button class="boton boton--grande" type="submit" id="guardar">' + VF.icono.svg('ok') + 'Registrar entrada</button>' +
      '</div></form>' +
      '</div>' +
      '<div id="ficha"></div>' +
      '</div>';

    const entradaCedula = document.getElementById('cedula');
    const resultado = document.getElementById('resultado-consulta');
    const forma = document.getElementById('forma-registro');
    const cuerpo = document.getElementById('cuerpo-forma');
    const ficha = document.getElementById('ficha');

    let consulta = null;   // lo que devolvio el servidor
    let catalogos = null;

    // Se acepta pegar la cedula con guiones o espacios.
    entradaCedula.addEventListener('input', () => {
      const d = entradaCedula.value.replace(/\D/g, '').slice(0, 11);
      entradaCedula.value = d.length > 10 ? d.slice(0, 3) + '-' + d.slice(3, 10) + '-' + d.slice(10) : d;
    });
    entradaCedula.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); consultar(); }
    });
    document.getElementById('consultar').addEventListener('click', consultar);

    async function consultar() {
      const cedula = entradaCedula.value.replace(/\D/g, '');
      if (cedula.length !== 11) {
        resultado.innerHTML =
          '<div class="aviso aviso--aviso mt-1">' + VF.icono.svg('alerta') +
          '<div>La cédula debe tener 11 dígitos.</div></div>';
        return;
      }
      resultado.innerHTML = VF.ui.cargando();
      ficha.innerHTML = '';
      forma.hidden = true;

      try {
        consulta = await VF.api.get('/api/registro/consultar' + VF.api.consulta({ cedula }));
      } catch (e) {
        resultado.innerHTML = '<div class="aviso aviso--peligro mt-1">' + VF.icono.svg('alerta') + '<div>' + VF.ui.esc(e.message) + '</div></div>';
        return;
      }

      const c = consulta.consulta;
      catalogos = c.catalogos;

      // Avisos: bloqueo, observacion, identidad no verificada, visita abierta.
      const avisos = [];
      if (c.vigilancia && c.vigilancia.bloqueado) {
        avisos.push(
          '<div class="aviso aviso--peligro">' + VF.icono.svg('escudo') +
          '<div><strong>Esta cédula está BLOQUEADA</strong><div>' + VF.ui.esc(c.vigilancia.motivo) + '</div>' +
          '<div class="texto-chico-2 mt-1">Severidad ' + VF.ui.esc(c.vigilancia.severidad) +
          (c.vigilancia.autorizado_por ? ' · autorizado por ' + VF.ui.esc(c.vigilancia.autorizado_por) : '') + '</div></div></div>'
        );
      } else if (c.vigilancia && c.vigilancia.observado) {
        avisos.push(
          '<div class="aviso aviso--aviso">' + VF.icono.svg('escudo') +
          '<div><strong>Visitante observado</strong><div>' + VF.ui.esc(c.vigilancia.motivo) + '</div></div></div>'
        );
      }
      if (c.visita_abierta) {
        avisos.push(
          '<div class="aviso aviso--aviso">' + VF.icono.svg('reloj') +
          '<div><strong>Ya está dentro</strong><div>Entró a las ' + VF.ui.esc(VF.ui.hora(c.visita_abierta.entrada)) +
          ' (visita ' + VF.ui.esc(c.visita_abierta.codigo) + '). Registre primero su salida.</div></div>' +
          '<button class="boton boton--secundario boton--chico" id="cerrar-abierta">Registrar salida</button></div>'
        );
      }
      if (c.preregistro) {
        avisos.push(
          '<div class="aviso aviso--info">' + VF.icono.svg('anuncio') +
          '<div><strong>Tenía visita anunciada</strong><div>El formulario se completó con lo que ya sabíamos. ' +
          'Código ' + VF.ui.esc(c.preregistro.codigo) + '.</div></div></div>'
        );
      }
      if (c.origen !== 'padron' && c.motivo) {
        avisos.push(
          '<div class="aviso aviso--aviso">' + VF.icono.svg('alerta') +
          '<div><strong>Identidad no verificada</strong><div>' + VF.ui.esc(c.motivo) +
          ' Puede continuar escribiendo los datos a mano.</div></div></div>'
        );
      }
      resultado.innerHTML = avisos.join('');

      const abierta = document.getElementById('cerrar-abierta');
      if (abierta && c.visita_abierta) {
        abierta.addEventListener('click', () => VF.paginas.registrarSalida(c.visita_abierta.id, consultar));
      }

      pintarFicha(c);
      prepararForma(c);
    }

    /** Ficha lateral con lo que se sabe del visitante. */
    function pintarFicha(c) {
      const ciudadano = c.ciudadano;
      if (!ciudadano) {
        ficha.innerHTML =
          '<div class="tarjeta"><div class="tarjeta__cuerpo">' + VF.ui.vacio({
            titulo: 'Sin datos de esa cédula',
            texto: 'No se encontró en la base. Puede registrar los datos a mano si su institución lo permite.',
            icono: 'buscar',
          }) + '</div></div>';
        return;
      }

      const clase = c.vigilancia && c.vigilancia.bloqueado ? ' ficha--bloqueado' : c.vigilancia && c.vigilancia.observado ? ' ficha--observado' : '';
      const conocido = c.conocido;

      const filas = [];
      if (ciudadano.edad !== null && ciudadano.edad !== undefined) filas.push(['Edad', ciudadano.edad + ' años']);
      if (ciudadano.sexo) filas.push(['Sexo', ciudadano.sexo === 'F' ? 'Femenino' : ciudadano.sexo === 'M' ? 'Masculino' : ciudadano.sexo]);
      if (ciudadano.estado_civil) filas.push(['Estado civil', ciudadano.estado_civil]);
      if (ciudadano.nacionalidad) filas.push(['Nacionalidad', ciudadano.nacionalidad]);
      if (ciudadano.ocupacion) filas.push(['Ocupación', ciudadano.ocupacion]);
      if (ciudadano.municipio) filas.push(['Municipio', ciudadano.municipio]);
      if (ciudadano.provincia) filas.push(['Provincia', ciudadano.provincia]);
      if (conocido && conocido.telefono) filas.push(['Teléfono', conocido.telefono]);
      if (conocido && conocido.empresa) filas.push(['Empresa', conocido.empresa]);

      ficha.innerHTML =
        '<div class="tarjeta ficha' + clase + '">' +
        '<div class="ficha__persona">' +
        '<div class="ficha__nombre">' + VF.ui.esc(ciudadano.nombre_completo || 'Sin nombre') + '</div>' +
        '<div class="ficha__cedula">' + VF.ui.esc(formatearCedula(ciudadano.cedula)) + '</div>' +
        '<div class="mt-1">' +
        (ciudadano.en_padron
          ? '<span class="verificado">' + VF.icono.svg('ok', { tamano: 13 }) + 'Verificado en la base</span>'
          : '<span class="verificado verificado--no">' + VF.icono.svg('alerta', { tamano: 13 }) + 'No verificado</span>') +
        (conocido && conocido.visitas_total > 1
          ? ' <span class="etiqueta etiqueta--marca">' + conocido.visitas_total + ' visitas</span>'
          : '') +
        '</div></div>' +
        '<dl class="ficha__datos">' +
        filas.map((f) => '<div class="ficha__dato"><dt>' + VF.ui.esc(f[0]) + '</dt><dd>' + VF.ui.esc(f[1]) + '</dd></div>').join('') +
        '</dl>' +
        (conocido && conocido.ultima_visita
          ? '<div class="tarjeta__pie texto-chico">' +
            '<div class="texto-suave">Última visita</div>' +
            '<div>' + VF.ui.esc(conocido.ultima_visita.fecha_legible || '') + '</div>' +
            '<div class="texto-suave">' + VF.ui.esc(conocido.ultima_visita.departamento || '') +
            (conocido.ultima_visita.visitado ? ' · ' + VF.ui.esc(conocido.ultima_visita.visitado) : '') + '</div></div>'
          : '') +
        '</div>';
    }

    /** Formulario de la visita, con lo que exige el motivo elegido. */
    function prepararForma(c) {
      const ciudadano = c.ciudadano || {};
      const aj = c.ajustes || {};
      const pre = c.preregistro;
      const cat = c.catalogos;

      const oblig = (clave, porDefecto) => (aj[clave] === undefined ? porDefecto : aj[clave] === true || aj[clave] === '1' || aj[clave] === 1);

      cuerpo.innerHTML =
        '<h3 class="mb-2">Datos de la visita</h3>' +
        '<div class="fila-campos">' +
        campo('nombre_completo', 'Nombre completo', ciudadano.nombre_completo || '', !ciudadano.en_padron) +
        '<div class="campo"><label class="campo__etiqueta" for="departamento_id">Departamento' +
        (oblig('exigir_departamento', false) ? ' <span class="req">*</span>' : '') + '</label>' +
        '<select class="selector" id="departamento_id"><option value="">— Elija —</option>' +
        cat.departamentos.map((d) => '<option value="' + d.id + '">' + VF.ui.esc(d.nombre) + '</option>').join('') +
        '</select></div>' +
        '</div>' +

        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="motivo_id">Motivo de la visita' +
        (oblig('exigir_motivo', true) ? ' <span class="req">*</span>' : '') + '</label>' +
        '<select class="selector" id="motivo_id"><option value="">— Elija —</option>' +
        cat.motivos.map((m) => '<option value="' + m.id + '"' +
          (m.exige_aprobacion ? ' data-aprobacion="1"' : '') + (m.avisa_anfitrion ? ' data-avisa="1"' : '') + '>' +
          VF.ui.esc(m.nombre) + '</option>').join('') +
        '</select><div class="campo__ayuda" id="nota-motivo"></div></div>' +
        campo('visitado', '¿A quién visita?', '', oblig('exigir_visitado', true)) +
        '</div>' +

        '<div class="fila-campos">' +
        campo('telefono', 'Teléfono', (c.conocido && c.conocido.telefono) || '', oblig('exigir_telefono', false), 'tel') +
        campo('correo', 'Correo', (c.conocido && c.conocido.correo) || '', false, 'email') +
        campo('empresa', 'Empresa o procedencia', (pre && pre.empresa) || (c.conocido && c.conocido.empresa) || '', oblig('exigir_empresa', false)) +
        '</div>' +

        '<div class="fila-campos fila-campos--3">' +
        (oblig('pedir_acompanantes', true) ? campo('acompanantes', 'Acompañantes', (pre && pre.acompanantes) || '0', false, 'number') : '') +
        (oblig('pedir_vehiculo', true)
          ? campo('vehiculo', 'Vehículo', (pre && pre.vehiculo) || '', false) + campo('placa', 'Placa', '', false)
          : '') +
        (oblig('pedir_temperatura', false) ? campo('temperatura', 'Temperatura (°C)', '', false, 'number') : '') +
        '</div>' +

        (oblig('pedir_pertenencias', true)
          ? '<div class="campo"><label class="campo__etiqueta" for="pertenencias">Pertenencias</label>' +
            '<input class="entrada" id="pertenencias" placeholder="Laptop, maletín, herramientas…"></div>'
          : '') +

        '<div class="campo"><label class="campo__etiqueta" for="observaciones">Observaciones</label>' +
        '<textarea class="area" id="observaciones" placeholder="Notas para la bitácora"></textarea></div>' +

        // La autorizacion de un bloqueo exige escribir el motivo: es lo que
        // queda como constancia de quien decidio dejarlo entrar.
        (c.vigilancia && c.vigilancia.bloqueado
          ? '<div class="aviso aviso--peligro">' + VF.icono.svg('escudo') +
            '<div class="crecer"><strong>Autorización requerida</strong>' +
            '<div class="texto-chico">Esta cédula está bloqueada. Para registrarla hay que dejar constancia de quién lo autoriza y por qué.</div>' +
            '<div class="campo mt-1 mb-0"><label class="campo__etiqueta" for="motivo_autorizacion">Motivo de la autorización <span class="req">*</span></label>' +
            '<textarea class="area" id="motivo_autorizacion" rows="2" placeholder="Autorizado por…"></textarea></div>' +
            '<label class="campo campo--interruptor mt-1"><input type="checkbox" class="interruptor" id="autorizar_bloqueado"> ' +
            '<span>Autorizo expresamente la entrada</span></label></div></div>'
          : '');

      forma.hidden = false;

      // El pre-registro se envia para que quede enlazado con la visita.
      if (pre) {
        const oculto = VF.ui.el('input', { type: 'hidden', id: 'preregistro_id', value: pre.id });
        cuerpo.appendChild(oculto);
      }

      // Aviso segun el motivo elegido.
      const selectorMotivo = document.getElementById('motivo_id');
      const nota = document.getElementById('nota-motivo');
      selectorMotivo.addEventListener('change', () => {
        const op = selectorMotivo.options[selectorMotivo.selectedIndex];
        const partes = [];
        if (op.dataset.aprobacion) partes.push('Este motivo exige aprobación antes de la entrada.');
        if (op.dataset.avisa) partes.push('Se avisará al anfitrión.');
        nota.textContent = partes.join(' ');
      });

      // El nombre solo se puede editar si la identidad no vino del padron.
      const campoNombre = document.getElementById('nombre_completo');
      if (campoNombre && ciudadano.en_padron) campoNombre.readOnly = true;

      forma.onsubmit = async (ev) => {
        ev.preventDefault();
        await guardar();
      };
    }

    function campo(id, etiqueta, valor, obligatorio, tipo) {
      return (
        '<div class="campo"><label class="campo__etiqueta" for="' + id + '">' + VF.ui.esc(etiqueta) +
        (obligatorio ? ' <span class="req">*</span>' : '') + '</label>' +
        '<input class="entrada" id="' + id + '" type="' + (tipo || 'text') + '" value="' + VF.ui.esc(valor || '') + '"' +
        (tipo === 'number' ? ' min="0"' : '') + '></div>'
      );
    }

    async function guardar() {
      const boton = document.getElementById('guardar');
      const datos = {
        cedula: entradaCedula.value.replace(/\D/g, ''),
        nombre_completo: valor('nombre_completo'),
        departamento_id: valor('departamento_id'),
        motivo_id: valor('motivo_id'),
        visitado: valor('visitado'),
        telefono: valor('telefono'),
        correo: valor('correo'),
        empresa: valor('empresa'),
        acompanantes: valor('acompanantes') || 0,
        vehiculo: valor('vehiculo'),
        placa: valor('placa'),
        temperatura: valor('temperatura'),
        pertenencias: valor('pertenencias'),
        observaciones: valor('observaciones'),
        preregistro_id: valor('preregistro_id'),
        autorizar_bloqueado: document.getElementById('autorizar_bloqueado')
          ? document.getElementById('autorizar_bloqueado').checked
          : false,
        motivo_autorizacion: valor('motivo_autorizacion'),
      };

      boton.disabled = true;
      boton.textContent = 'Registrando…';

      try {
        const r = await VF.api.post('/api/registro', datos);

        // El gafete se abre solo o se deja el boton, segun el ajuste.
        const imprimir = consulta && consulta.consulta && consulta.consulta.ajustes &&
          (consulta.consulta.ajustes.imprimir_automatico === true || consulta.consulta.ajustes.imprimir_automatico === '1');

        (r.avisos || []).forEach((a) => {
          VF.ui.aviso(a.nivel === 'peligro' ? 'peligro' : a.nivel === 'aviso' ? 'aviso' : 'info', 'Aviso', a.texto, 9000);
        });

        VF.ui.aviso('exito', 'Visita registrada', r.visita.nombre_completo + ' · ' + r.visita.codigo);

        if (imprimir) {
          VF.paginas.verGafete(r.visita.id);
        } else {
          VF.ui.aviso('info', 'Gafete listo', 'Puede imprimirlo desde la bitácora o desde aquí.', 0);
          const flotante = document.querySelector('.avisos-flotantes .flotante:last-child');
          if (flotante) {
            const boton = VF.ui.el('button', { clase: 'boton boton--secundario boton--chico mt-1', texto: 'Imprimir gafete' });
            boton.addEventListener('click', () => { flotante.remove(); VF.paginas.verGafete(r.visita.id); });
            flotante.querySelector('div').appendChild(boton);
          }
        }

        VF.barra.refrescarInsignias();
        setTimeout(() => { location.hash = '#/panel'; }, imprimir ? 1200 : 900);
      } catch (e) {
        if (e.estado === 409) {
          VF.ui.aviso('aviso', 'Ya está dentro', e.message, 9000);
        } else if (e.datos && e.datos.requiere_autorizacion) {
          VF.ui.aviso('peligro', 'Cédula bloqueada', e.message, 9000);
        } else {
          VF.ui.aviso('peligro', 'No se pudo registrar', e.message, 9000);
        }
        boton.disabled = false;
        boton.innerHTML = VF.icono.svg('ok') + 'Registrar entrada';
      }
    }

    function valor(id) {
      const n = document.getElementById(id);
      return n ? n.value.trim() : '';
    }

    document.getElementById('limpiar').addEventListener('click', () => {
      entradaCedula.value = '';
      resultado.innerHTML = '';
      ficha.innerHTML = '';
      forma.hidden = true;
      consulta = null;
      entradaCedula.focus();
    });

    /* --- Busqueda por nombre, cuando no traen la cedula --- */
    document.getElementById('buscar-nombre').addEventListener('click', (ev) => {
      ev.preventDefault();
      VF.ui.dialogo(
        'Buscar por nombre',
        '<div class="campo"><label class="campo__etiqueta" for="q">Nombre o apellido</label>' +
        '<input class="entrada" id="q" placeholder="Escriba el nombre o el apellido" autofocus>' +
        '<div class="campo__ayuda">Puede escribir el nombre y el apellido juntos: ABREU GUZMAN.</div></div>' +
        '<div id="res"></div>',
      );
      const campoQ = document.getElementById('q');
      const res = document.getElementById('res');

      const buscar = VF.ui.rebote(async () => {
        const q = campoQ.value.trim();
        if (q.length < 2) { res.innerHTML = ''; return; }
        res.innerHTML = VF.ui.cargando();
        try {
          const r = await VF.api.get('/api/registro/buscar' + VF.api.consulta({ q }));
          if (!r.resultados.length) {
            res.innerHTML = '<div class="aviso aviso--aviso">' + VF.icono.svg('info') + '<div>' +
              VF.ui.esc(r.motivo || 'No se encontró nadie con ese nombre.') + '</div></div>';
            return;
          }
          res.innerHTML = '<div class="resultados">' + r.resultados.map((c) =>
            '<button class="resultado" data-cedula="' + VF.ui.esc(c.cedula) + '">' +
            '<div class="crecer"><div class="resultado__nombre">' + VF.ui.esc(c.nombre_completo) + '</div>' +
            '<div class="resultado__meta">' + VF.ui.esc(formatearCedula(c.cedula)) +
            (c.municipio ? ' · ' + VF.ui.esc(c.municipio) : '') + '</div></div>' +
            VF.icono.svg('chevron') + '</button>').join('') + '</div>';

          res.querySelectorAll('[data-cedula]').forEach((b) => {
            b.addEventListener('click', () => {
              entradaCedula.value = formatearCedula(b.dataset.cedula);
              document.querySelector('.dialogo').close();
              consultar();
            });
          });
        } catch (e) {
          res.innerHTML = '<div class="aviso aviso--peligro">' + VF.icono.svg('alerta') + '<div>' + VF.ui.esc(e.message) + '</div></div>';
        }
      }, 350);

      campoQ.addEventListener('input', buscar);
    });

    // Si llega con una cedula en la direccion, se consulta sola.
    if (params.cedula) {
      entradaCedula.value = formatearCedula(params.cedula);
      consultar();
    }
  },
});

/* ============================================================================
   SALIDA (se usa desde el panel, el registro y la lista de dentro)
   ============================================================================ */

VF.paginas.registrarSalida = async function (visitaId, alTerminar) {
  const ok = await VF.ui.confirmar(
    'Registrar salida',
    '¿Confirma que esta persona está saliendo de las instalaciones?',
    { textoSi: 'Registrar salida' }
  );
  if (!ok) return;
  try {
    const r = await VF.api.post('/api/visitas/' + visitaId + '/salida');
    VF.ui.aviso('exito', 'Salida registrada', r.visita.nombre_completo + ' · estuvo ' + (r.visita.duracion || '—'));
    VF.barra.refrescarInsignias();
    if (alTerminar) alTerminar();
  } catch (e) {
    VF.ui.aviso('peligro', 'No se pudo registrar la salida', e.message);
  }
};
