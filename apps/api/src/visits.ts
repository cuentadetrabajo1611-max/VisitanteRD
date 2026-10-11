import { randomUUID } from 'node:crypto';
import { CreateVisit, Visit } from '@visitante/core';
import sql from 'mssql';

export interface VisitRepository {
  listActive(): Promise<Visit[]>;
  create(input: CreateVisit): Promise<Visit>;
  checkout(id: string): Promise<Visit | null>;
}
export class MemoryVisitRepository implements VisitRepository {
  private readonly visits = new Map<string, Visit>();
  async listActive() { return [...this.visits.values()].filter(v => !v.exitedAt).map(v => ({ ...v })); }
  async create(input: CreateVisit) {
    const visit: Visit = { ...input, id: randomUUID(), enteredAt: new Date().toISOString(), exitedAt: null };
    this.visits.set(visit.id, visit); return { ...visit };
  }
  async checkout(id: string) {
    const visit = this.visits.get(id);
    if (!visit || visit.exitedAt) return null;
    visit.exitedAt = new Date().toISOString(); return { ...visit };
  }
}
const columns = 'id, visitorLabel, destination, purpose, enteredAt, exitedAt';
function rowVisit(row: Record<string, unknown>): Visit {
  return { id: String(row.id), visitorLabel: String(row.visitorLabel), destination: String(row.destination),
    purpose: String(row.purpose), enteredAt: (row.enteredAt as Date).toISOString(),
    exitedAt: row.exitedAt ? (row.exitedAt as Date).toISOString() : null };
}
export class SqlVisitRepository implements VisitRepository {
  constructor(private readonly pool: sql.ConnectionPool) {}
  async listActive() {
    const result = await this.pool.request().query(`SELECT TOP (200) ${columns} FROM dbo.Visits WHERE exitedAt IS NULL ORDER BY enteredAt DESC`);
    return result.recordset.map(rowVisit);
  }
  async create(input: CreateVisit) {
    const result = await this.pool.request().input('id', sql.UniqueIdentifier, randomUUID())
      .input('label', sql.NVarChar(120), input.visitorLabel).input('destination', sql.NVarChar(120), input.destination)
      .input('purpose', sql.NVarChar(240), input.purpose)
      .query(`INSERT dbo.Visits (id, visitorLabel, destination, purpose) OUTPUT ${columns.split(', ').map(c => `INSERTED.${c}`).join(', ')} VALUES (@id, @label, @destination, @purpose)`);
    return rowVisit(result.recordset[0]);
  }
  async checkout(id: string) {
    const result = await this.pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`UPDATE dbo.Visits SET exitedAt = SYSUTCDATETIME() OUTPUT ${columns.split(', ').map(c => `INSERTED.${c}`).join(', ')} WHERE id = @id AND exitedAt IS NULL`);
    return result.recordset[0] ? rowVisit(result.recordset[0]) : null;
  }
}
