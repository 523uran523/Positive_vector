import os, sqlite3

db_path = os.path.join('data', 'positive_vector.db')

# Remove old db if exists
if os.path.exists(db_path):
    os.remove(db_path)

# Create new db
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Read and run migration 001_init.sql
with open('server/migrations/001_init.sql', 'r', encoding='utf-8') as f:
    sql = f.read()
cursor.executescript(sql)

# Run remaining migrations
for i in range(2, 13):
    migration_file = f'server/migrations/{i:03d}_init.sql'
    if os.path.exists(migration_file):
        with open(migration_file, 'r') as f:
            sql = f.read()
        cursor.executescript(sql)

# Seed default settings
defaults = [
    ('company_name', 'Позитив Вектор'),
    ('default_shift_rate_kopecks', 300000),
    ('order_tags', ['Баннер', 'Вывеска', 'Декорации', 'Металлоконструкция', 'Срочно', 'Ночной монтаж']),
    ('expense_categories', ['materials', 'fuel', 'rent', 'salaries', 'other']),
    ('units', ['шт', 'м', 'м²', 'л', 'кг', 'рулон', 'уп']),
    ('material_categories', ['Баннерная ткань', 'Брус и пиломатериалы', 'Краска и химия', 'Крепёж и саморезы', 'Металл и профиль', 'Электрика', 'Прочее']),
    ('default_theme', 'light'),
    ('email_notifications', {'enabled': False, 'smtpHost': '', 'fromAddress': ''}),
]
for k, v in defaults:
    cursor.execute('INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', 
                   (k, str(v), '2026-01-01T00:00:00'))

conn.commit()
conn.close()
print('Database created successfully!')