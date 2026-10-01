import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { identifier, sql } from '../../src/data/storage/sql.js';

describe('SQLite query builder', () => {
  it('binds untrusted values without changing the query structure', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE items (name TEXT); INSERT INTO items VALUES (\'safe\')');
      const attack = `safe' OR 1=1 -- <script>alert(1)</script>`;
      const query = sql`SELECT name FROM ${identifier('items')} WHERE name = ${attack}`;
      expect(query).toEqual({
        text: 'SELECT name FROM "items" WHERE name = ?',
        values: [attack]
      });
      expect(database.prepare(query.text).all(...query.values)).toEqual([]);
      expect(database.prepare('SELECT name FROM items').all()).toEqual([{ name: 'safe' }]);
    } finally {
      database.close();
    }
  });

  it('quotes identifiers including embedded quotes instead of executing injected SQL', () => {
    const name = 'items"; DROP TABLE items; --';
    const query = sql`SELECT * FROM ${identifier(name)} WHERE name = ${'safe'}`;
    expect(query.text).toBe('SELECT * FROM "items""; DROP TABLE items; --" WHERE name = ?');
    expect(query.values).toEqual(['safe']);
    expect(() => identifier('bad\0name')).toThrow(TypeError);
  });

  it('rejects unsupported parameters rather than coercing them into SQL', () => {
    expect(() => sql`SELECT ${undefined}`).toThrow(TypeError);
    expect(() => sql`SELECT ${{ raw: '1 OR 1=1' }}`).toThrow(TypeError);
    expect(() => sql`SELECT ${Infinity}`).toThrow(TypeError);
  });
});
