import { FormEvent, useCallback, useEffect, useState } from 'react';
interface Visit {id:string;visitorLabel:string;destination:string;purpose:string;enteredAt:string;}
async function request<T>(path:string, init?:RequestInit):Promise<T> {
  const response = await fetch(`/api/${path}`,init);
  if (!response.ok) throw new Error('No se pudo completar la operación. Comprueba la conexión y vuelve a intentarlo.');
  return response.json() as Promise<T>;
}
export function App() {
  const [visits,setVisits]=useState<Visit[]>([]);
  const [mode,setMode]=useState<'loading'|'demo'|'configured'|'offline'>('loading');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const refresh=useCallback(async()=> {
    try {
      const health=await request<{mode:'demo'|'configured'}>('health'); setMode(health.mode);
      // The prototype supports demo only; real reception waits for user sessions.
      if(health.mode==='demo') setVisits(await request<Visit[]>('visits'));
    } catch {setMode('offline');setError('No hay conexión con recepción. Inicia la API y pulsa Actualizar.');}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function create(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=event.currentTarget;const data=new FormData(form);
    setBusy(true);setError('');setNotice('');
    try {await request('visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visitorLabel:data.get('visitorLabel'),destination:data.get('destination'),purpose:data.get('purpose')})});
      form.reset();await refresh();setNotice('Entrada registrada en la demostración.');
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  async function checkout(id:string) {
    setBusy(true);setError('');setNotice('');
    try {await request(`visits/${id}/checkout`,{method:'POST'});await refresh();setNotice('Salida registrada.');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const enabled=mode==='demo';
  return <><header><a className="brand" href="/">VisitanteRD<span>Recepción</span></a><span className="connection">{mode==='demo'?'Demostración local':mode==='offline'?'Sin conexión':mode==='loading'?'Conectando…':'Configuración real'}</span></header>
    <main><div className="intro"><h1>Registro de visitantes</h1><p>Registra una entrada y confirma la salida cuando finalice la visita.</p></div>
      <aside className="demo-note">{enabled?'Esta demostración se guarda en memoria. Usa únicamente datos ficticios; se borran al reiniciar.':'El registro está deshabilitado. La recepción con datos reales requiere sesiones de usuario y permisos, pendientes de la siguiente fase.'}</aside>
      <div role="alert" className={error?'message error':'message'}>{error}</div><div role="status" className="message">{notice}</div>
      <div className="workspace"><section aria-labelledby="entry-title"><h2 id="entry-title">Nueva entrada</h2><form onSubmit={event=>void create(event)}>
        <label htmlFor="visitorLabel">Nombre ficticio del visitante</label><input id="visitorLabel" name="visitorLabel" required minLength={2} maxLength={120} placeholder="Ej. Visitante de prueba" disabled={!enabled||busy}/>
        <label htmlFor="destination">Área de destino</label><input id="destination" name="destination" required minLength={2} maxLength={120} placeholder="Ej. Administración" disabled={!enabled||busy}/>
        <label htmlFor="purpose">Motivo de la visita</label><textarea id="purpose" name="purpose" required minLength={2} maxLength={240} rows={3} disabled={!enabled||busy}/>
        <button className="primary" disabled={!enabled||busy}>{busy?'Guardando…':'Registrar entrada'}</button></form></section>
        <section className="activity" aria-labelledby="active-title"><div className="section-heading"><h2 id="active-title">Dentro del edificio <span className="count">{visits.length}</span></h2><button onClick={()=>{setError('');void refresh();}} disabled={busy}>Actualizar</button></div>
          {visits.length===0?<div className="empty"><h3>{mode==='loading'?'Cargando visitas…':'No hay visitas activas'}</h3><p>Las entradas registradas aparecerán aquí hasta que confirmes su salida.</p></div>:<ul className="visit-list">{visits.map(visit=><li key={visit.id}><div><strong>{visit.visitorLabel}</strong><p>{visit.destination} · {visit.purpose}</p><time dateTime={visit.enteredAt}>Entrada {new Date(visit.enteredAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</time></div><button disabled={busy||!enabled} onClick={()=>void checkout(visit.id)}>Registrar salida</button></li>)}</ul>}
        </section></div><footer>VisitanteRD · Base de desarrollo 0.1 · Padrón pendiente de configuración</footer>
    </main></>;
}
