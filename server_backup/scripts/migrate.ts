import 'dotenv/config';
import { openDatabase, runMigrations } from '../db.ts';

const db = openDatabase();
const applied = runMigrations(db);
console.log(
  applied.length > 0
    ? `Применены миграции: ${applied.join(', ')}`
    : 'Все миграции уже применены.'
);
db.close();
