import { expect,it,vi } from 'vitest';
import sql from 'mssql';
import { REGISTRY_QUERY,SqlRegistryReader,normalizeDocument } from '../apps/api/src/registry';
it('rejects invalid documents before any SQL call',async()=>{
  const request=vi.fn(); const reader=new SqlRegistryReader({request} as unknown as sql.ConnectionPool);
  await expect(reader.find("'; DROP TABLE x;--")).rejects.toThrow();expect(request).not.toHaveBeenCalled();
});
it('uses a single SELECT with a bound value',async()=>{
  const query=vi.fn().mockResolvedValue({recordset:[{registryId:'test-id',displayName:'Synthetic Person'}]});
  const input=vi.fn().mockReturnValue({query});
  const reader=new SqlRegistryReader({request:()=>({input})} as unknown as sql.ConnectionPool);
  expect(await reader.find('000-0000000-0')).toEqual({registryId:'test-id',displayName:'Synthetic Person'});
  expect(input).toHaveBeenCalledWith('document',sql.VarChar(11),'00000000000');
  expect(query).toHaveBeenCalledWith(REGISTRY_QUERY);expect(REGISTRY_QUERY).toMatch(/^SELECT /);
  expect(normalizeDocument('00000000000')).toBe('00000000000');
});
