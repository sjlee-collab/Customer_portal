import pg from 'pg';

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const { rows } = await getPool().query(sql, params);
  return rows;
}
