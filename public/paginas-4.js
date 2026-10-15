/* ============================================================================
   VisitaFlow - Pantallas de configuracion, personalizacion, usuarios y licencia
   ============================================================================ */

VF.paginas = VF.paginas || {};

/* ============================================================================
   CONFIGURACION
   ============================================================================ */

VF.registrarRuta('configuracion', {
  titulo: 'Configuración',
  permiso: 'config.ver',
  async pintar(cont, params) {
    let pestana = params.tab || 'departamentos';
    let config = null;

    const CATALOGOS = {
      departamentos: {
        titulo: 'Departamentos',
        ayuda: 'A dónde va el visitante. El encargado y su correo sirven para avisarle cuando llega alguien.',
        columnas: [
          { clave: 'nombre', titulo: 'Nombre', principal: true },
          { clave: 'encargado', titulo: 'Encargado' },
          { clave: 'correo', titulo: 'Correo de aviso' },
        ],
        campos: [
          { clave: 'nombre', etiqueta: 'Nombre', obligatorio: true },
          { clave: 'encargado', etiqueta: 'Encargado' },
          { clave: 'correo', etiqueta: 'Correo de aviso', tipo: 'email' },
          { clave: 'telefono', etiqueta: 'Teléfono', tipo: 'tel' },
        ],
      },
      motivos: {
        titulo: 'Motivos de visita',
        ayuda: 'Las reglas de cada motivo: si avisa al anfitrión o si exige aprobación antes de dejar entrar.',
        columnas: [
          { clave: 'nombre', titulo: 'Motivo', principal: true },
          { clave: 'reglas', titulo: 'Reglas', render: (f) =>
              (f.avisa_anfitrion ? '<span class="etiqueta etiqueta--info">Avisa</span> ' : '') +
              (f.exige_aprobacion ? '<span class="etiqueta etiqueta--pendiente">Aprueba</span> ' : '') +
              (f.exige_documento ? '<span class="etiqueta">Documento</span>' : '') || '<span class="texto-tenue">—</span>' },
        ],
        campos: [
          { clave: 'nombre', etiqueta: 'Nombre del motivo', obligatorio: true },
          { clave: 'avisa_anfitrion', etiqueta: 'Avisar al anfitrión', tipo: 'booleano' },
          { clave: 'exige_aprobacion', etiqueta: 'Exige aprobación antes de entrar', tipo: 'booleano' },
          { clave: 'exige_documento', etiqueta: 'Exige documento', tipo: 'booleano' },
          { clave: 'exige_vehiculo', etiqueta: 'Preguntar por vehículo', tipo: 'booleano' },
          { clave: 'exige_pertenencias', etiqueta: 'Preguntar por pertenencias', tipo: 'booleano' },
          { clave: 'exige_temperatura', etiqueta: 'Registrar temperatura', tipo: 'booleano' },
        ],
      },
      personas: {
        titulo: 'Personas',
        ayuda: 'El personal interno que recibe visitas. Con esta lista el recepcionista elige a quién visita en vez de escribir el nombre, y el sistema le avisa cuando llega alguien.',
        columnas: [
          { clave: 'nombre', titulo: 'Nombre', principal: true },
          { clave: 'cargo', titulo: 'Cargo' },
          { clave: 'departamento', titulo: 'Departamento' },
          { clave: 'correo', titulo: 'Correo de aviso' },
          { clave: 'recibe_visitas', titulo: 'Recibe visitas', render: (f) =>
              f.recibe_visitas ? '<span class="etiqueta etiqueta--info">Sí</span>' : '<span class="texto-tenue">No</span>' },
        ],
        campos: [
          { clave: 'nombre', etiqueta: 'Nombre completo', obligatorio: true },
          { clave: 'cargo', etiqueta: 'Cargo' },
          { clave: 'departamento_id', etiqueta: 'Departamento', tipo: 'lista', de: 'departamentos' },
          { clave: 'correo', etiqueta: 'Correo para avisarle', tipo: 'email' },
          { clave: 'telefono', etiqueta: 'Teléfono', tipo: 'tel' },
          { clave: 'recibe_visitas', etiqueta: 'Recibe visitas', tipo: 'booleano' },
        ],
      },
      categorias: {
        titulo: 'Tipos de visitante',
        ayuda: 'Proveedor, cliente, contratista… y si ese tipo exige documento.',
        columnas: [
          { clave: 'nombre', titulo: 'Tipo', principal: true },
          { clave: 'exige_documento', titulo: 'Exige documento', render: (f) => (f.exige_documento ? 'Sí' : 'No') },
        ],
        campos: [
          { clave: 'nombre', etiqueta: 'Nombre del tipo', obligatorio: true },
          { clave: 'exige_documento', etiqueta: 'Exige documento', tipo: 'booleano' },
        ],
      },
      sedes: {
        titulo: 'Sedes',
        ayuda: 'Las ubicaciones de la institución, con su horario.',
        columnas: [
          { clave: 'nombre', titulo: 'Sede', principal: true },
          { clave: 'direccion', titulo: 'Dirección' },
          { clave: 'horario', titulo: 'Horario', render: (f) => (f.hora_desde || f.hora_hasta ? (f.hora_desde || '') + ' – ' + (f.hora_hasta || '') : '—') },
        ],
        campos: [
          { clave: 'nombre', etiqueta: 'Nombre de la sede', obligatorio: true },
          { clave: 'direccion', etiqueta: 'Dirección' },
          { clave: 'hora_desde', etiqueta: 'Abre a las', tipo: 'hora' },
          { clave: 'hora_hasta', etiqueta: 'Cierra a las', tipo: 'hora' },
        ],
      },
    };

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      config = await VF.api.get('/api/config');

      VF.cabecera('Configuración', 'Catálogos y ajustes del sistema');

      cont.innerHTML =
        '<div class="pestanas" role="tablist">' +
        Object.keys(CATALOGOS).map((k) =>
          '<button class="pestana" role="tab" data-tab="' + k + '" aria-selected="' + (pestana === k) + '">' + VF.ui.esc(CATALOGOS[k].titulo) + '</button>').join('') +
        '<button class="pestana" role="tab" data-tab="ajustes" aria-selected="' + (pestana === 'ajustes') + '">Ajustes</button>' +
        '<button class="pestana" role="tab" data-tab="auditoria" aria-selected="' + (pestana === 'auditoria') + '">Auditoría</button>' +
        '</div>' +
        '<div id="cuerpo-config"></div>';

      const cuerpo = document.getElementById('cuerpo-config');

      if (pestana === 'ajustes') {
        cuerpo.innerHTML = pintarAjustes();
        conectarAjustes();
      } else if (pestana === 'auditoria') {
        await pintarAuditoria(cuerpo);
      } else {
        const def = CATALOGOS[pestana];
        const filas = config[pestana] || [];

        cuerpo.innerHTML =
          '<div class="fila fila--separada mb-2">' +
          '<div class="texto-chico texto-suave">' + VF.ui.esc(def.ayuda) + '</div>' +
          (VF.tiene('config.editar')
            ? '<button class="boton" id="nuevo-item">' + VF.icono.svg('mas') + 'Nuevo</button>'
            : '') +
          '</div>' +
          (filas.length
            ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
              def.columnas.map((c) => '<th>' + VF.ui.esc(c.titulo) + '</th>').join('') +
              '<th>Estado</th><th></th></tr></thead><tbody>' +
              filas.map((f) => '<tr' + (f.activo === false ? ' style="opacity:.55"' : '') + '>' +
                def.columnas.map((c) => {
                  const valor = c.render ? c.render(f) : (f[c.clave] || '—');
                  return c.principal
                    ? '<td class="tabla__principal">' + valor + '</td>'
                    : '<td class="texto-chico">' + valor + '</td>';
                }).join('') +
                '<td>' + (f.activo === false ? '<span class="etiqueta">Desactivado</span>' : '<span class="etiqueta etiqueta--dentro">Activo</span>') + '</td>' +
                '<td><div class="tabla__acciones">' +
                (VF.tiene('config.editar')
                  ? '<button class="boton boton--fantasma boton--chico" data-editar="' + f.id + '" title="Editar">' + VF.icono.svg('editar') + '</button>' +
                    (f.activo === false
                      ? ''
                      : '<button class="boton boton--fantasma boton--chico" data-desactivar="' + f.id + '" title="Desactivar">' + VF.icono.svg('basura') + '</button>')
                  : '') +
                '</div></td></tr>').join('') +
              '</tbody></table></div></div>'
            : VF.ui.vacio({
                titulo: 'No hay ' + def.titulo.toLowerCase() + ' todavía',
                texto: def.ayuda,
                icono: 'carpeta',
                accion: VF.tiene('config.editar') ? { clave: 'nuevo', texto: 'Crear el primero' } : null,
              }));

        const nuevo = document.getElementById('nuevo-item');
        if (nuevo) nuevo.addEventListener('click', () => formularioCatalogo(pestana, null));

        cuerpo.querySelectorAll('[data-editar]').forEach((b) => {
          b.addEventListener('click', () => {
            const f = filas.find((x) => String(x.id) === String(b.dataset.editar));
            formularioCatalogo(pestana, f);
          });
        });

        cuerpo.querySelectorAll('[data-desactivar]').forEach((b) => {
          b.addEventListener('click', async () => {
            const ok = await VF.ui.confirmar(
              'Desactivar',
              'No se borra: queda desactivado y los registros históricos siguen apuntando a él.',
              { textoSi: 'Desactivar' }
            );
            if (!ok) return;
            try {
              await VF.api.borrar('/api/config/' + pestana + '/' + b.dataset.desactivar);
              VF.ui.aviso('exito', 'Desactivado');
              cargar();
            } catch (e) {
              VF.ui.aviso('peligro', 'No se pudo desactivar', e.message);
            }
          });
        });
      }

      cont.querySelectorAll('[data-tab]').forEach((b) => {
        b.addEventListener('click', () => { pestana = b.dataset.tab; cargar(); });
      });

      if (cont.dataset.accionNuevo === '1') {
        cont.dataset.accionNuevo = '';
        if (CATALOGOS[pestana] && VF.tiene('config.editar')) formularioCatalogo(pestana, null);
      }
    }

    function formularioCatalogo(nombre, actual) {
      const def = CATALOGOS[nombre];
      const campos = def.campos.map((c) => {
        const valor = actual ? actual[c.clave] : '';
        if (c.tipo === 'booleano') {
          const marcado = actual ? Boolean(actual[c.clave]) : c.clave !== 'exige_aprobacion';
          return '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="c-' + c.clave + '"' +
            (marcado ? ' checked' : '') + '><span>' + VF.ui.esc(c.etiqueta) + '</span></label>';
        }

        /* Campo de lista: el valor es el id de otro catálogo. Se le pasa el
           catálogo de donde salen las opciones ("de"), que ya viene cargado en
           config. La opción vacía está a propósito: hay personas que no
           pertenecen a un departamento concreto. */
        if (c.tipo === 'lista') {
          const opciones = (config && config[c.de] ? config[c.de] : [])
            .filter((o) => o.activo)
            .map((o) => '<option value="' + o.id + '"' +
              (String(valor) === String(o.id) ? ' selected' : '') + '>' + VF.ui.esc(o.nombre) + '</option>')
            .join('');
          return '<div class="campo"><label class="campo__etiqueta" for="c-' + c.clave + '">' + VF.ui.esc(c.etiqueta) +
            (c.obligatorio ? ' <span class="req">*</span>' : '') + '</label>' +
            '<select class="entrada" id="c-' + c.clave + '">' +
            '<option value="">— Sin asignar —</option>' + opciones + '</select>' +
            '<div class="campo__ayuda">' + VF.ui.esc(c.ayuda || '') + '</div></div>';
        }

        const tipo = c.tipo === 'hora' ? 'time' : c.tipo || 'text';
        return '<div class="campo"><label class="campo__etiqueta" for="c-' + c.clave + '">' + VF.ui.esc(c.etiqueta) +
          (c.obligatorio ? ' <span class="req">*</span>' : '') + '</label>' +
          '<input class="entrada" type="' + tipo + '" id="c-' + c.clave + '" value="' + VF.ui.esc(valor || '') + '"></div>';
      });

      VF.ui.dialogo(
        (actual ? 'Editar ' : 'Nuevo ') + def.titulo.toLowerCase().replace(/s$/, ''),
        campos.join(''),
        {
          pie:
            '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
            '<button class="boton" id="c-guardar">Guardar</button>',
        }
      );

      document.getElementById('c-guardar').addEventListener('click', async () => {
        const datos = {};
        def.campos.forEach((c) => {
          const n = document.getElementById('c-' + c.clave);
          if (!n) return;
          datos[c.clave] = c.tipo === 'booleano' ? n.checked : n.value.trim();
        });
        const faltante = def.campos.find((c) => c.obligatorio && !datos[c.clave]);
        if (faltante) {
          VF.ui.aviso('aviso', 'Falta un dato', 'Complete "' + faltante.etiqueta + '".');
          return;
        }
        try {
          if (actual) await VF.api.patch('/api/config/' + nombre + '/' + actual.id, datos);
          else await VF.api.post('/api/config/' + nombre, datos);
          VF.ui.aviso('exito', 'Guardado');
          document.querySelector('.dialogo').close();
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
        }
      });
    }

    function pintarAjustes() {
      const grupos = {};
      config.ajustes.forEach((a) => {
        if (!grupos[a.grupo]) grupos[a.grupo] = [];
        grupos[a.grupo].push(a);
      });

      const titulos = {
        general: 'General',
        registro: 'Al registrar una visita',
        recepcion: 'Recepción',
        gafete: 'Gafete',
        preregistro: 'Visitas anunciadas',
      };

      return Object.keys(grupos).map((g) =>
        '<div class="tarjeta mb-2"><div class="tarjeta__cabecera"><h3>' + VF.ui.esc(titulos[g] || g) + '</h3></div>' +
        '<div class="tarjeta__cuerpo">' +
        grupos[g].map((a) => {
          const id = 'a-' + a.clave;
          if (a.tipo === 'booleano') {
            return '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="' + id + '"' +
              (String(a.valor) === '1' || a.valor === true ? ' checked' : '') + '>' +
              '<span>' + VF.ui.esc(a.descripcion || a.clave) + '</span></label>';
          }
          return '<div class="campo"><label class="campo__etiqueta" for="' + id + '">' + VF.ui.esc(a.descripcion || a.clave) + '</label>' +
            '<input class="entrada" id="' + id + '" type="' + (a.tipo === 'numero' ? 'number' : 'text') + '" value="' + VF.ui.esc(a.valor || '') + '" style="max-width:320px">' +
            '<div class="campo__ayuda texto-mono">' + VF.ui.esc(a.clave) + '</div></div>';
        }).join('') +
        '</div></div>'
      ).join('') +
      (VF.tiene('config.editar')
        ? '<div class="barra-acciones barra-acciones--fin"><button class="boton boton--grande" id="guardar-ajustes">Guardar ajustes</button></div>'
        : '');
    }

    function conectarAjustes() {
      const boton = document.getElementById('guardar-ajustes');
      if (!boton) return;
      boton.addEventListener('click', async () => {
        const ajustes = {};
        config.ajustes.forEach((a) => {
          const n = document.getElementById('a-' + a.clave);
          if (!n) return;
          ajustes[a.clave] = a.tipo === 'booleano' ? (n.checked ? '1' : '0') : n.value;
        });
        boton.disabled = true;
        boton.textContent = 'Guardando…';
        try {
          const r = await VF.api.patch('/api/config/ajustes', { ajustes });
          config = r.config;
          VF.ui.aviso('exito', 'Ajustes guardados', r.guardados + ' cambio(s) aplicado(s).');
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudieron guardar', e.message);
        }
        boton.disabled = false;
        boton.textContent = 'Guardar ajustes';
      });
    }

    async function pintarAuditoria(cuerpo) {
      if (!VF.tiene('auditoria.ver')) {
        cuerpo.innerHTML = VF.ui.vacio({ titulo: 'Sin permiso', texto: 'Su usuario no puede consultar la bitácora de auditoría.', icono: 'escudo' });
        return;
      }
      cuerpo.innerHTML = VF.ui.cargando();
      const r = await VF.api.get('/api/auditoria?tamano=50');
      cuerpo.innerHTML =
        '<div class="texto-chico texto-suave mb-2">Todo lo que cambia datos o expone información personal queda anotado aquí.</div>' +
        (r.listado.filas.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla tabla--compacta"><thead><tr>' +
            '<th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead><tbody>' +
            r.listado.filas.map((f) => '<tr>' +
              '<td class="texto-chico">' + VF.ui.esc(VF.ui.fecha(f.fecha, true)) + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(f.usuario || '—') + '</td>' +
              '<td><span class="etiqueta etiqueta--marca">' + VF.ui.esc(f.accion) + '</span></td>' +
              '<td class="texto-chico">' + VF.ui.esc(f.detalle || '—') + '</td>' +
              '<td class="texto-chico texto-mono">' + VF.ui.esc(f.ip || '—') + '</td>' +
              '</tr>').join('') +
            '</tbody></table></div></div>' +
            '<div class="texto-chico texto-suave mt-2">' + r.listado.total + ' registro(s) en total. Se muestran los últimos 50.</div>'
          : VF.ui.vacio({ titulo: 'La auditoría está vacía', icono: 'bitacora' }));
    }

    await cargar();
  },
});

/* ============================================================================
   PERSONALIZACION
   ============================================================================ */

VF.registrarRuta('personalizacion', {
  titulo: 'Personalización',
  permiso: 'config.ver',
  async pintar(cont) {
    let datos = null;
    const puedeEditar = VF.tiene('personalizacion.editar');

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      datos = await VF.api.get('/api/personalizacion');
      const i = datos.institucion;

      VF.cabecera(
        'Personalización',
        'El logo y los colores de su institución',
        puedeEditar ? '<button class="boton boton--grande" id="guardar">Guardar cambios</button>' : ''
      );

      cont.innerHTML =
        '<div class="rejilla rejilla--2">' +

        /* --- Logo --- */
        '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Logo</h2></div>' +
        '<div class="tarjeta__cuerpo">' +
        '<div style="border:2px dashed var(--borde-fuerte);border-radius:var(--radio);padding:1.5rem;text-align:center;background:var(--superficie-2)">' +
        '<div id="vista-logo" style="min-height:80px;display:grid;place-items:center">' +
        (datos.marca.logo_url
          ? '<img src="' + VF.ui.esc(datos.marca.logo_url) + '" alt="Logo actual" style="max-height:80px;max-width:100%">'
          : '<div class="texto-suave texto-chico">Sin logo. Se usan las iniciales del nombre.</div>') +
        '</div>' +
        '<div class="barra-acciones mt-2" style="justify-content:center">' +
        (puedeEditar
          ? '<button class="boton boton--secundario boton--chico" id="subir-logo">Subir logo</button>' +
            (datos.marca.logo_url ? '<button class="boton boton--fantasma boton--chico" id="quitar-logo">Quitar</button>' : '')
          : '') +
        '</div>' +
        '<input type="file" id="archivo-logo" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden>' +
        '<div class="campo__ayuda mt-1">PNG, JPG, SVG o WEBP. Máximo 2 MB. Se recomienda fondo transparente y al menos 200×60 px.</div>' +
        '</div>' +
        '</div></div>' +

        /* --- Colores --- */
        '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Colores institucionales</h2></div>' +
        '<div class="tarjeta__cuerpo">' +
        color('color_primario', 'Color principal', i.color_primario, 'Menú lateral, botones y encabezado del gafete') +
        color('color_secundario', 'Color secundario', i.color_secundario, 'Acentos y detalles') +
        color('color_acento', 'Color de acento', i.color_acento, 'Gráficos y resaltados') +
        color('color_texto', 'Color del texto', i.color_texto, 'Texto principal de la interfaz') +
        '<div class="aviso aviso--info mt-1">' + VF.icono.svg('info') +
        '<div class="texto-chico">El sistema calcula solo el color del texto sobre el color principal, para que la marca no rompa la legibilidad. ' +
        'Contraste actual: <strong>' + (datos.marca.colores.contraste_primario || '—') + ':1</strong>.</div></div>' +
        '</div></div>' +

        /* --- Datos de la institucion --- */
        '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Datos de la institución</h2></div>' +
        '<div class="tarjeta__cuerpo">' +
        campo('nombre', 'Nombre legal', i.nombre) +
        campo('nombre_comercial', 'Nombre para mostrar', i.nombre_comercial) +
        campo('contacto_nombre', 'Persona de contacto', i.contacto_nombre) +
        campo('contacto_correo', 'Correo de contacto', i.contacto_correo, 'email') +
        campo('contacto_telefono', 'Teléfono', i.contacto_telefono, 'tel') +
        campo('texto_gafete', 'Texto al pie del gafete', i.texto_gafete) +
        '</div></div>' +

        /* --- Vista previa --- */
        '<div class="tarjeta"><div class="tarjeta__cabecera"><h2>Vista previa</h2></div>' +
        '<div class="tarjeta__cuerpo">' +
        '<div id="previa" style="border:1px solid var(--borde);border-radius:var(--radio);overflow:hidden">' +
        '<div id="previa-franja" style="background:' + VF.ui.esc(datos.marca.colores.primario) + ';color:' + VF.ui.esc(datos.marca.colores.texto_sobre_primario) + ';padding:1rem;display:flex;align-items:center;gap:.7rem">' +
        '<div id="previa-logo" style="width:44px;height:44px;border-radius:8px;background:rgba(255,255,255,.2);display:grid;place-items:center;overflow:hidden;font-weight:700">' +
        (datos.marca.logo_url ? '<img src="' + VF.ui.esc(datos.marca.logo_url) + '" style="width:100%;height:100%;object-fit:contain;background:#fff" alt="">' : VF.ui.esc(VF.ui.iniciales(datos.marca.nombre_comercial))) +
        '</div>' +
        '<div><div id="previa-nombre" style="font-weight:700">' + VF.ui.esc(datos.marca.nombre_comercial) + '</div>' +
        '<div style="font-size:.75rem;opacity:.85">Gafete de visitante</div></div>' +
        '</div>' +
        '<div style="padding:1rem;background:#fff">' +
        '<div style="font-weight:700">Juan Pérez Martínez</div>' +
        '<div style="font-family:var(--fuente-mono);font-size:.85rem;color:var(--texto-suave)">001-1234567-8</div>' +
        '<div style="margin-top:.6rem;font-size:.85rem">Visita a: <strong>Recursos Humanos</strong></div>' +
        '<div style="margin-top:.4rem;display:flex;gap:.5rem;align-items:center">' +
        '<span style="background:' + VF.ui.esc(datos.marca.colores.primario) + ';color:' + VF.ui.esc(datos.marca.colores.texto_sobre_primario) + ';padding:.2rem .6rem;border-radius:99px;font-size:.75rem;font-weight:600">Dentro</span>' +
        '<span style="background:' + VF.ui.esc(datos.marca.colores.primario_claro || '#eef2ff') + ';color:' + VF.ui.esc(datos.marca.colores.primario) + ';padding:.2rem .6rem;border-radius:99px;font-size:.75rem;font-weight:600">VF-20261015-ABCD</span>' +
        '</div></div>' +
        '</div></div>' +
        '<div class="texto-chico texto-suave mt-1">Los cambios de color se aplican a todo el sistema y al gafete impreso.</div>' +
        '</div></div>' +

        '</div>';

      function color(clave, etiqueta, valor, ayuda) {
        return '<div class="campo"><label class="campo__etiqueta" for="i-' + clave + '">' + VF.ui.esc(etiqueta) + '</label>' +
          '<div class="fila">' +
          '<input type="color" id="i-' + clave + '" value="' + VF.ui.esc(valor || '#000000') + '" style="width:52px;height:38px;padding:2px;border:1px solid var(--borde-fuerte);border-radius:6px;cursor:pointer"' + (puedeEditar ? '' : ' disabled') + '>' +
          '<input class="entrada texto-mono" id="t-' + clave + '" value="' + VF.ui.esc(valor || '') + '" style="max-width:130px"' + (puedeEditar ? '' : ' readonly') + '>' +
          '</div><div class="campo__ayuda">' + VF.ui.esc(ayuda) + '</div></div>';
      }

      function campo(clave, etiqueta, valor, tipo) {
        return '<div class="campo"><label class="campo__etiqueta" for="i-' + clave + '">' + VF.ui.esc(etiqueta) + '</label>' +
          '<input class="entrada" type="' + (tipo || 'text') + '" id="i-' + clave + '" value="' + VF.ui.esc(valor || '') + '"' +
          (puedeEditar ? '' : ' readonly') + '></div>';
      }

      // El selector de color y el campo de texto se siguen el uno al otro.
      ['color_primario', 'color_secundario', 'color_acento', 'color_texto'].forEach((clave) => {
        const selector = document.getElementById('i-' + clave);
        const texto = document.getElementById('t-' + clave);
        if (!selector || !texto) return;
        selector.addEventListener('input', () => {
          texto.value = selector.value;
          vistaPrevia();
        });
        texto.addEventListener('input', () => {
          if (/^#[0-9a-fA-F]{6}$/.test(texto.value)) selector.value = texto.value;
          vistaPrevia();
        });
      });

      ['nombre_comercial'].forEach((clave) => {
        const n = document.getElementById('i-' + clave);
        if (n) n.addEventListener('input', vistaPrevia);
      });

      /** Refresca la vista previa y, de paso, toda la interfaz. */
      function vistaPrevia() {
        const marca = {
          primario: document.getElementById('t-color_primario').value,
          secundario: document.getElementById('t-color_secundario').value,
          acento: document.getElementById('t-color_acento').value,
          texto: document.getElementById('t-color_texto').value,
        };
        const nombre = document.getElementById('i-nombre_comercial').value || 'Institución';
        document.getElementById('previa-franja').style.background = marca.primario;
        document.getElementById('previa-nombre').textContent = nombre;
        // Se aplica en vivo: asi se ve el efecto antes de guardar.
        document.documentElement.style.setProperty('--marca', marca.primario);
        document.documentElement.style.setProperty('--marca-acento', marca.acento);
        document.documentElement.style.setProperty('--marca-secundaria', marca.secundario);
      }

      /* --- Logo --- */
      const subir = document.getElementById('subir-logo');
      const archivo = document.getElementById('archivo-logo');
      if (subir && archivo) {
        subir.addEventListener('click', () => archivo.click());
        archivo.addEventListener('change', async () => {
          const f = archivo.files[0];
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) {
            VF.ui.aviso('aviso', 'Archivo muy grande', 'El logo no puede pasar de 2 MB.');
            return;
          }
          const lector = new FileReader();
          lector.onload = async () => {
            try {
              const r = await VF.api.post('/api/personalizacion/logo', { imagen: lector.result });
              VF.aplicarMarca(r.marca);
              VF.ui.aviso('exito', 'Logo actualizado');
              cargar();
            } catch (e) {
              VF.ui.aviso('peligro', 'No se pudo subir el logo', e.message);
            }
          };
          lector.readAsDataURL(f);
        });
      }

      const quitar = document.getElementById('quitar-logo');
      if (quitar) {
        quitar.addEventListener('click', async () => {
          const ok = await VF.ui.confirmar('Quitar el logo', 'Se usarán las iniciales del nombre en su lugar.');
          if (!ok) return;
          try {
            const r = await VF.api.borrar('/api/personalizacion/logo');
            VF.aplicarMarca(r.marca);
            VF.ui.aviso('exito', 'Logo quitado');
            cargar();
          } catch (e) {
            VF.ui.aviso('peligro', 'No se pudo quitar', e.message);
          }
        });
      }

      /* --- Guardar --- */
      const guardar = document.getElementById('guardar');
      if (guardar) {
        guardar.addEventListener('click', async () => {
          const cambios = {
            nombre: document.getElementById('i-nombre').value.trim(),
            nombre_comercial: document.getElementById('i-nombre_comercial').value.trim(),
            contacto_nombre: document.getElementById('i-contacto_nombre').value.trim(),
            contacto_correo: document.getElementById('i-contacto_correo').value.trim(),
            contacto_telefono: document.getElementById('i-contacto_telefono').value.trim(),
            texto_gafete: document.getElementById('i-texto_gafete').value.trim(),
            color_primario: document.getElementById('t-color_primario').value,
            color_secundario: document.getElementById('t-color_secundario').value,
            color_acento: document.getElementById('t-color_acento').value,
            color_texto: document.getElementById('t-color_texto').value,
          };
          guardar.disabled = true;
          guardar.textContent = 'Guardando…';
          try {
            const r = await VF.api.patch('/api/personalizacion', cambios);
            VF.aplicarMarca(r.marca);
            VF.barra.pintar();
            VF.ui.aviso('exito', 'Personalización guardada', 'Los colores ya se aplican en todo el sistema.');
          } catch (e) {
            VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
          }
          guardar.disabled = false;
          guardar.textContent = 'Guardar cambios';
        });
      }
    }

    await cargar();
  },
});

/* ============================================================================
   USUARIOS Y PERMISOS
   ============================================================================ */

VF.registrarRuta('usuarios', {
  titulo: 'Usuarios y permisos',
  permiso: 'usuarios.ver',
  async pintar(cont, params) {
    let pestana = params.tab || 'usuarios';
    let datos = null;
    let sedes = [];

    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      datos = await VF.api.get('/api/usuarios');
      try {
        const s = await VF.api.get('/api/config/sedes?activos=1');
        sedes = s.filas;
      } catch (e) {
        sedes = [];
      }

      VF.cabecera(
        'Usuarios y permisos',
        datos.limite ? 'Su licencia permite ' + datos.limite + ' usuario(s) activo(s)' : 'Operadores del sistema y qué puede cada rol',
        VF.tiene('usuarios.editar') ? '<button class="boton" id="nuevo-usuario">' + VF.icono.svg('mas') + 'Nuevo usuario</button>' : ''
      );

      cont.innerHTML =
        '<div class="pestanas" role="tablist">' +
        '<button class="pestana" role="tab" data-tab="usuarios" aria-selected="' + (pestana === 'usuarios') + '">Usuarios</button>' +
        '<button class="pestana" role="tab" data-tab="roles" aria-selected="' + (pestana === 'roles') + '">Permisos por rol</button>' +
        '</div><div id="cuerpo"></div>';

      const cuerpo = document.getElementById('cuerpo');

      if (pestana === 'usuarios') {
        cuerpo.innerHTML = datos.usuarios.length
          ? '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
            '<th>Nombre</th><th>Correo</th><th>Rol</th><th>Sede</th><th>Último acceso</th><th>Estado</th><th></th>' +
            '</tr></thead><tbody>' +
            datos.usuarios.map((u) => '<tr' + (u.activo ? '' : ' style="opacity:.55"') + '>' +
              '<td class="tabla__principal">' + VF.ui.esc(u.nombre) + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(u.correo) + '</td>' +
              '<td><span class="etiqueta etiqueta--marca">' + VF.ui.esc(u.rol_nombre) + '</span></td>' +
              '<td class="texto-chico">' + VF.ui.esc(u.sede || '—') + '</td>' +
              '<td class="texto-chico">' + VF.ui.esc(u.ultimo_acceso_legible || 'nunca') + '</td>' +
              '<td>' + (u.activo ? '<span class="etiqueta etiqueta--dentro">Activo</span>' : '<span class="etiqueta">Desactivado</span>') + '</td>' +
              '<td><div class="tabla__acciones">' +
              (VF.tiene('usuarios.editar')
                ? '<button class="boton boton--fantasma boton--chico" data-clave="' + u.id + '" title="Restablecer contraseña">' + VF.icono.svg('llave') + '</button>' +
                  '<button class="boton boton--fantasma boton--chico" data-editar="' + u.id + '" title="Editar">' + VF.icono.svg('editar') + '</button>' +
                  (u.activo
                    ? '<button class="boton boton--fantasma boton--chico" data-desactivar="' + u.id + '" title="Desactivar">' + VF.icono.svg('basura') + '</button>'
                    : '<button class="boton boton--secundario boton--chico" data-activar="' + u.id + '">Activar</button>')
                : '') +
              '</div></td></tr>').join('') +
            '</tbody></table></div></div>'
          : VF.ui.vacio({ titulo: 'No hay usuarios', icono: 'usuarios' });

        const nuevo = document.getElementById('nuevo-usuario');
        if (nuevo) nuevo.addEventListener('click', () => formularioUsuario(null));

        cuerpo.querySelectorAll('[data-editar]').forEach((b) => {
          b.addEventListener('click', () => formularioUsuario(datos.usuarios.find((u) => String(u.id) === String(b.dataset.editar))));
        });

        cuerpo.querySelectorAll('[data-clave]').forEach((b) => {
          b.addEventListener('click', async () => {
            const clave = await VF.ui.preguntar(
              'Restablecer contraseña',
              'Nueva contraseña',
              { textoSi: 'Cambiar', ayuda: 'Mínimo 8 caracteres, con al menos una letra y un número.' }
            );
            if (!clave) return;
            try {
              await VF.api.post('/api/usuarios/' + b.dataset.clave + '/clave', { clave });
              VF.ui.aviso('exito', 'Contraseña cambiada', 'Comuníquesela al operador.');
            } catch (e) {
              VF.ui.aviso('peligro', 'No se pudo cambiar', e.message);
            }
          });
        });

        cuerpo.querySelectorAll('[data-desactivar]').forEach((b) => {
          b.addEventListener('click', async () => {
            const ok = await VF.ui.confirmar('Desactivar usuario', 'No podrá entrar al sistema. Sus registros se conservan.', { textoSi: 'Desactivar' });
            if (!ok) return;
            try {
              await VF.api.borrar('/api/usuarios/' + b.dataset.desactivar);
              VF.ui.aviso('exito', 'Usuario desactivado');
              cargar();
            } catch (e) {
              VF.ui.aviso('peligro', 'No se pudo desactivar', e.message);
            }
          });
        });

        cuerpo.querySelectorAll('[data-activar]').forEach((b) => {
          b.addEventListener('click', async () => {
            try {
              await VF.api.patch('/api/usuarios/' + b.dataset.activar, { activo: true });
              VF.ui.aviso('exito', 'Usuario activado');
              cargar();
            } catch (e) {
              VF.ui.aviso('peligro', 'No se pudo activar', e.message);
            }
          });
        });
      } else {
        /* --- Matriz de permisos por rol --- */
        const porGrupo = {};
        datos.permisos.forEach((p) => {
          if (!porGrupo[p.grupo]) porGrupo[p.grupo] = [];
          porGrupo[p.grupo].push(p);
        });

        cuerpo.innerHTML =
          '<div class="aviso aviso--info">' + VF.icono.svg('info') +
          '<div class="texto-chico">Los permisos se guardan por rol. El rol <strong>administrador</strong> conserva todos los permisos por diseño: ' +
          'si alguien borra una asignación por error, el sistema no se queda sin acceso.</div></div>' +
          '<div class="tarjeta"><div class="tabla-envoltura"><table class="tabla"><thead><tr>' +
          '<th>Permiso</th>' + datos.roles.map((r) => '<th class="texto-centro">' + VF.ui.esc(r.nombre) + '</th>').join('') +
          '</tr></thead><tbody>' +
          Object.keys(porGrupo).map((g) =>
            '<tr><td colspan="' + (datos.roles.length + 1) + '" style="background:var(--superficie-2);font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em">' +
            VF.ui.esc(g) + '</td></tr>' +
            porGrupo[g].map((p) => '<tr>' +
              '<td><div>' + VF.ui.esc(p.descripcion) + '</div>' +
              '<div class="texto-mono texto-chico-2 texto-tenue">' + VF.ui.esc(p.clave) + '</div></td>' +
              datos.roles.map((r) => {
                const tiene = r.rol === 'admin' || r.permisos.indexOf(p.clave) !== -1;
                const deshabilitado = r.rol === 'admin' || !VF.tiene('usuarios.editar');
                return '<td class="texto-centro"><input type="checkbox" class="interruptor" ' +
                  'data-rol="' + r.rol + '" data-permiso="' + VF.ui.esc(p.clave) + '"' +
                  (tiene ? ' checked' : '') + (deshabilitado ? ' disabled' : '') + '></td>';
              }).join('') +
              '</tr>').join('')
          ).join('') +
          '</tbody></table></div></div>' +
          (VF.tiene('usuarios.editar')
            ? '<div class="barra-acciones barra-acciones--fin mt-2"><button class="boton boton--grande" id="guardar-permisos">Guardar permisos</button></div>'
            : '');

        const guardar = document.getElementById('guardar-permisos');
        if (guardar) {
          guardar.addEventListener('click', async () => {
            guardar.disabled = true;
            guardar.textContent = 'Guardando…';
            // Se agrupan las casillas por rol y se guarda cada rol.
            for (const rol of datos.roles) {
              if (rol.rol === 'admin') continue;
              const permisos = Array.from(cuerpo.querySelectorAll('[data-rol="' + rol.rol + '"]'))
                .filter((c) => c.checked)
                .map((c) => c.dataset.permiso);
              try {
                await VF.api.put('/api/usuarios/roles/' + rol.rol, { permisos });
              } catch (e) {
                VF.ui.aviso('peligro', 'No se pudo guardar el rol ' + rol.nombre, e.message);
                guardar.disabled = false;
                guardar.textContent = 'Guardar permisos';
                return;
              }
            }
            VF.ui.aviso('exito', 'Permisos guardados', 'Los cambios se aplican en el próximo acceso de cada usuario.');
            guardar.disabled = false;
            guardar.textContent = 'Guardar permisos';
          });
        }
      }

      cont.querySelectorAll('[data-tab]').forEach((b) => {
        b.addEventListener('click', () => { pestana = b.dataset.tab; cargar(); });
      });
    }

    function formularioUsuario(actual) {
      const u = actual || {};
      VF.ui.dialogo(
        actual ? 'Editar usuario' : 'Nuevo usuario',
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="u-nombre">Nombre completo <span class="req">*</span></label>' +
        '<input class="entrada" id="u-nombre" value="' + VF.ui.esc(u.nombre || '') + '"></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="u-correo">Correo <span class="req">*</span></label>' +
        '<input class="entrada" type="email" id="u-correo" value="' + VF.ui.esc(u.correo || '') + '"></div>' +
        '</div>' +
        '<div class="fila-campos">' +
        '<div class="campo"><label class="campo__etiqueta" for="u-rol">Rol <span class="req">*</span></label>' +
        '<select class="selector" id="u-rol">' +
        datos.roles.map((r) => '<option value="' + r.rol + '"' + (u.rol === r.rol ? ' selected' : '') + '>' + VF.ui.esc(r.nombre) + '</option>').join('') +
        '</select><div class="campo__ayuda">El rol define los permisos.</div></div>' +
        '<div class="campo"><label class="campo__etiqueta" for="u-telefono">Teléfono</label>' +
        '<input class="entrada" type="tel" id="u-telefono" value="' + VF.ui.esc(u.telefono || '') + '"></div>' +
        '</div>' +
        (sedes.length
          ? '<div class="campo"><label class="campo__etiqueta" for="u-sede">Sede</label>' +
            '<select class="selector" id="u-sede"><option value="">— Sin sede asignada —</option>' +
            sedes.map((s) => '<option value="' + s.id + '"' + (String(u.sede_id) === String(s.id) ? ' selected' : '') + '>' + VF.ui.esc(s.nombre) + '</option>').join('') +
            '</select></div>'
          : '') +
        (actual ? '' :
          '<div class="campo"><label class="campo__etiqueta" for="u-clave">Contraseña <span class="req">*</span></label>' +
          '<input class="entrada" type="text" id="u-clave" autocomplete="new-password">' +
          '<div class="campo__ayuda">Mínimo 8 caracteres, con al menos una letra y un número. Comuníquesela al operador y que la cambie.</div></div>') +
        '<label class="campo campo--interruptor"><input type="checkbox" class="interruptor" id="u-activo"' +
        (actual ? (u.activo ? ' checked' : '') : ' checked') + '><span>Usuario activo</span></label>',
        {
          pie:
            '<button class="boton boton--secundario" data-cerrar>Cancelar</button>' +
            '<button class="boton" id="u-guardar">' + (actual ? 'Guardar cambios' : 'Crear usuario') + '</button>',
        }
      );

      document.getElementById('u-guardar').addEventListener('click', async () => {
        const datosForm = {
          nombre: document.getElementById('u-nombre').value.trim(),
          correo: document.getElementById('u-correo').value.trim(),
          rol: document.getElementById('u-rol').value,
          telefono: document.getElementById('u-telefono').value.trim(),
          sede_id: document.getElementById('u-sede') ? document.getElementById('u-sede').value : null,
          activo: document.getElementById('u-activo').checked,
        };
        if (!datosForm.nombre || !datosForm.correo) {
          VF.ui.aviso('aviso', 'Faltan datos', 'El nombre y el correo son obligatorios.');
          return;
        }
        try {
          if (actual) {
            await VF.api.patch('/api/usuarios/' + actual.id, datosForm);
            VF.ui.aviso('exito', 'Usuario actualizado');
          } else {
            datosForm.clave = document.getElementById('u-clave').value;
            await VF.api.post('/api/usuarios', datosForm);
            VF.ui.aviso('exito', 'Usuario creado', 'Ya puede entrar con su correo y la contraseña asignada.');
          }
          document.querySelector('.dialogo').close();
          cargar();
        } catch (e) {
          VF.ui.aviso('peligro', 'No se pudo guardar', e.message);
        }
      });
    }

    await cargar();
  },
});

/* ============================================================================
   LICENCIA
   ============================================================================ */

VF.registrarRuta('licencia', {
  titulo: 'Licencia',
  permiso: 'licencia.ver',
  async pintar(cont) {
    async function cargar() {
      cont.innerHTML = VF.ui.cargando();
      const r = await VF.api.get('/api/licencia');
      const l = r.licencia;

      VF.cabecera('Licencia', 'Estado de la activación de esta instalación');

      const estados = {
        activa: { texto: 'Activa', color: 'dentro', icono: 'ok' },
        por_vencer: { texto: 'Por vencer', color: 'pendiente', icono: 'reloj' },
        gracia: { texto: 'En periodo de gracia', color: 'pendiente', icono: 'reloj' },
        vencida: { texto: 'Vencida', color: 'peligro', icono: 'alerta' },
        invalida: { texto: 'Inválida', color: 'peligro', icono: 'alerta' },
        sin_licencia: { texto: 'Sin licencia', color: 'peligro', icono: 'alerta' },
        no_vigente: { texto: 'Aún no vigente', color: 'info', icono: 'reloj' },
        otro_equipo: { texto: 'Amarrada a otro equipo', color: 'peligro', icono: 'alerta' },
      };
      const e = estados[l.estado] || estados.invalida;

      const modulos = l.modulos_disponibles.map((m) =>
        '<span class="etiqueta ' + (l.modulos.indexOf(m) !== -1 ? 'etiqueta--dentro' : '') + '">' +
        VF.ui.esc(m) + (l.modulos.indexOf(m) !== -1 ? '' : ' — no incluido') + '</span>').join(' ');

      cont.innerHTML =
        '<div class="rejilla rejilla--panel">' +
        '<div>' +

        '<div class="tarjeta mb-2"><div class="tarjeta__cabecera">' +
        '<h2>Estado</h2>' +
        '<span class="etiqueta etiqueta--' + e.color + '">' + e.texto + '</span>' +
        '</div><div class="tarjeta__cuerpo">' +
        (l.motivo ? '<div class="aviso aviso--' + (l.valida ? 'info' : 'peligro') + '">' + VF.icono.svg(e.icono) + '<div>' + VF.ui.esc(l.motivo) + '</div></div>' : '') +
        (l.licencia
          ? '<dl class="ficha__datos">' +
            fila('Cliente', l.licencia.cliente) +
            fila('Institución', l.licencia.tenant) +
            fila('Licencia', l.licencia.licencia_id) +
            fila('Tipo', l.licencia.tipo) +
            fila('Desde', l.licencia.desde ? l.licencia.desde.slice(0, 10) : '—') +
            fila('Hasta', l.licencia.hasta ? l.licencia.hasta.slice(0, 10) : '—') +
            fila('Días restantes', l.dias_restantes > 0 ? l.dias_restantes : '0') +
            fila('Periodo de gracia', l.licencia.gracia_dias + ' días') +
            fila('Usuarios permitidos', l.licencia.limites ? l.licencia.limites.usuarios : '—') +
            fila('Instalaciones permitidas', l.licencia.limites ? l.licencia.limites.instalaciones : '—') +
            fila('Amarrada a', l.licencia.huella || 'cualquier equipo') +
            (l.licencia.notas ? fila('Notas', l.licencia.notas) : '') +
            '</dl>'
          : '<div class="texto-suave">Esta instalación no tiene ninguna licencia cargada. Pegue el archivo que le entregó su proveedor.</div>') +
        '<div class="texto-chico texto-suave mt-2">Origen: ' + VF.ui.esc(l.origen || '—') +
        ' · Última revisión: ' + VF.ui.esc(VF.ui.fecha(l.revisada, true)) + '</div>' +
        '</div></div>' +

        '<div class="tarjeta"><div class="tarjeta__cabecera"><h3>Módulos habilitados</h3></div>' +
        '<div class="tarjeta__cuerpo"><div class="fila fila--envuelve">' + modulos + '</div>' +
        '<div class="campo__ayuda mt-1">Si su licencia no incluye un módulo, las pantallas correspondientes quedan bloqueadas para dar de alta información nueva.</div>' +
        '</div></div>' +

        '</div>' +

        '<div>' +

        (VF.tiene('licencia.activar')
          ? '<div class="tarjeta mb-2"><div class="tarjeta__cabecera"><h2>Activar o renovar</h2></div>' +
            '<div class="tarjeta__cuerpo">' +
            '<div class="campo"><label class="campo__etiqueta" for="archivo-lic">Archivo de licencia (.vflow)</label>' +
            '<input class="entrada" type="file" id="archivo-lic" accept=".vflow,.txt">' +
            '<div class="campo__ayuda">O pegue el contenido abajo.</div></div>' +
            '<div class="campo"><textarea class="area entrada--mono" id="texto-lic" rows="5" placeholder="-----BEGIN VISITAFLOW LICENSE-----"></textarea></div>' +
            '<div class="barra-acciones">' +
            '<button class="boton" id="activar-lic">Activar</button>' +
            '<button class="boton boton--secundario" id="renovar-lic">Buscar en el servidor</button>' +
            '</div></div></div>'
          : '') +

        '<div class="tarjeta mb-2"><div class="tarjeta__cabecera"><h3>Este equipo</h3></div>' +
        '<div class="tarjeta__cuerpo"><dl class="ficha__datos">' +
        fila('Nombre', l.equipo.nombre) +
        fila('Sistema', l.equipo.sistema) +
        fila('Arquitectura', l.equipo.arquitectura) +
        fila('Procesadores', l.equipo.procesadores) +
        fila('Memoria', l.equipo.memoria_gb + ' GB') +
        '</dl>' +
        '<div class="campo mt-2"><label class="campo__etiqueta">Huella del equipo</label>' +
        '<input class="entrada entrada--mono" readonly value="' + VF.ui.esc(l.equipo.huella) + '" id="huella">' +
        '<div class="campo__ayuda">Si su licencia está amarrada a un equipo, es esta huella. Pásela a su proveedor al solicitarla.</div></div>' +
        '</div></div>' +

        '</div>' +

        '</div>';

      function fila(etiqueta, valor) {
        return '<div class="ficha__dato"><dt>' + VF.ui.esc(etiqueta) + '</dt><dd>' + VF.ui.esc(valor === null || valor === undefined ? '—' : valor) + '</dd></div>';
      }

      const archivo = document.getElementById('archivo-lic');
      if (archivo) {
        archivo.addEventListener('change', () => {
          const f = archivo.files[0];
          if (!f) return;
          const lector = new FileReader();
          lector.onload = () => { document.getElementById('texto-lic').value = lector.result; };
          lector.readAsText(f);
        });

        document.getElementById('activar-lic').addEventListener('click', async () => {
          const texto = document.getElementById('texto-lic').value.trim();
          if (!texto) {
            VF.ui.aviso('aviso', 'Sin licencia', 'Seleccione el archivo o pegue su contenido.');
            return;
          }
          try {
            const rr = await VF.api.post('/api/licencia/activar', { texto });
            VF.estado.licencia = rr.licencia;
            VF.pintarAvisoLicencia();
            VF.ui.aviso('exito', 'Licencia activada', rr.licencia.licencia ? rr.licencia.licencia.cliente : '');
            cargar();
          } catch (e) {
            VF.ui.aviso('peligro', 'No se pudo activar', e.message, 12000);
          }
        });

        document.getElementById('renovar-lic').addEventListener('click', async () => {
          try {
            const rr = await VF.api.post('/api/licencia/renovar', {});
            VF.estado.licencia = rr.licencia;
            VF.pintarAvisoLicencia();
            VF.ui.aviso('exito', 'Licencia actualizada');
            cargar();
          } catch (e) {
            VF.ui.aviso('aviso', 'Sin novedades', e.message);
          }
        });
      }
    }

    await cargar();
  },
});

/* ============================================================================
   Restablecer contrasena (llega por enlace desde el correo)
   ============================================================================ */

VF.registrarRuta('restablecer', {
  titulo: 'Restablecer contraseña',
  async pintar(cont, params) {
    document.getElementById('app').hidden = true;
    const acceso = document.getElementById('acceso');
    acceso.hidden = false;

    if (!params.token) {
      acceso.innerHTML = '<div class="acceso"><div class="acceso__caja"><div class="tarjeta"><div class="tarjeta__cuerpo">' +
        VF.ui.vacio({ titulo: 'Enlace incompleto', texto: 'El enlace de recuperación no trae el token. Pida uno nuevo.', icono: 'llave' }) +
        '</div></div></div></div>';
      return;
    }

    acceso.innerHTML =
      '<div class="acceso"><div class="acceso__caja">' +
      '<div class="acceso__marca"><div class="acceso__logo">' + VF.icono.svg('llave', { tamano: 26 }) + '</div>' +
      '<div class="acceso__titulo">Nueva contraseña</div></div>' +
      '<div class="tarjeta"><div class="tarjeta__cuerpo">' +
      '<div class="campo"><label class="campo__etiqueta" for="nueva">Contraseña nueva</label>' +
      '<input class="entrada" type="password" id="nueva" autocomplete="new-password">' +
      '<div class="campo__ayuda">Mínimo 8 caracteres, con al menos una letra y un número.</div></div>' +
      '<div class="campo"><label class="campo__etiqueta" for="repetir">Repítala</label>' +
      '<input class="entrada" type="password" id="repetir" autocomplete="new-password"></div>' +
      '<button class="boton boton--bloque" id="cambiar">Cambiar la contraseña</button>' +
      '</div></div></div></div>';

    document.getElementById('cambiar').addEventListener('click', async () => {
      const nueva = document.getElementById('nueva').value;
      const repetir = document.getElementById('repetir').value;
      if (nueva !== repetir) {
        VF.ui.aviso('aviso', 'No coinciden', 'Las dos contraseñas deben ser iguales.');
        return;
      }
      try {
        await VF.api.post('/api/acceso/restablecer', { token: params.token, clave: nueva }, { sinRedirigir: true });
        VF.ui.aviso('exito', 'Contraseña cambiada', 'Ya puede entrar con su nueva contraseña.');
        setTimeout(() => { location.hash = '#/acceso'; location.reload(); }, 1200);
      } catch (e) {
        VF.ui.aviso('peligro', 'No se pudo cambiar', e.message);
      }
    });
  },
});
