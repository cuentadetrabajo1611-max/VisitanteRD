import sql from 'mssql';

// Integration contract: an administrator creates this view only in a disposable
// restored COPY after inspecting its schema. No MDF attach/restore is performed here.
export const REGISTRY_QUERY = 'SELECT TOP (1) RegistryId AS registryId, DisplayName AS displayName FROM dbo.VisitanteRegistryLookup WHERE DocumentNumber = @document';
export interface RegistryPerson { registryId: string; displayName: string; }
export interface RegistryReader { find(document: string): Promise<RegistryPerson | null>; }
export function normalizeDocument(value: string) {
  const normalized = value.replace(/-/g, '');
  if (!/^\d{11}$/.test(normalized)) throw new Error('Document must contain 11 digits');
  return normalized;
}
export class SqlRegistryReader implements RegistryReader {
  constructor(private readonly pool: sql.ConnectionPool) {}
  async find(document: string) {
    const normalized = normalizeDocument(document);
    const result = await this.pool.request().input('document', sql.VarChar(11), normalized).query(REGISTRY_QUERY);
    const row = result.recordset[0];
    return row ? { registryId: String(row.registryId), displayName: String(row.displayName) } : null;
  }
}
