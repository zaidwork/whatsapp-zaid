import fs from 'fs';
import path from 'path';
import db from './db.js';

async function setupDatabase() {
  console.log("🚀 Starting database tables setup on Turso...");

  try {
    // قراءة ملف schema.sql من المجلد الرئيسي
    const sqlPath = path.resolve('../schema.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Could not find schema.sql at: ${sqlPath}`);
    }

    const sqlContent = fs.readFileSync(sqlPath, 'utf-8');

    // إزالة التعليقات السطرية أولاً
    const cleanSql = sqlContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => !line.startsWith('--'))
      .join('\n');

    // تقسيم الملف إلى استعلامات مستقلة باستخدام الفاصلة المنقوطة
    const statements = cleanSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    console.log(`Found ${statements.length} SQL statements to execute.`);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      // استخراج اسم الجدول للتوضيح في الكونسول
      const match = stmt.match(/CREATE\s+TABLE\s+(\w+)/i) || stmt.match(/CREATE\s+INDEX\s+(\w+)/i);
      const name = match ? match[1] : `Statement ${i + 1}`;

      try {
        // لتجنب أخطاء تكرار الجداول الموجودة أصلاً
        // نقوم بتحويل CREATE TABLE إلى CREATE TABLE IF NOT EXISTS إن أمكن
        let modifiedStmt = stmt;
        if (stmt.toUpperCase().includes("CREATE TABLE") && !stmt.toUpperCase().includes("IF NOT EXISTS")) {
          modifiedStmt = stmt.replace(/CREATE\s+TABLE/i, "CREATE TABLE IF NOT EXISTS");
        }

        await db.execute(modifiedStmt);
        console.log(`✅ Success: Created/Verified ${name}`);
      } catch (stmtErr) {
        // تجاهل أخطاء التكرار إن وجدت
        if (stmtErr.message.includes("already exists")) {
          console.log(`ℹ️ Already exists: ${name}`);
        } else {
          console.error(`❌ Error executing ${name}:`, stmtErr.message);
        }
      }
    }

    console.log("\n🎉 Database setup completed successfully!");
  } catch (err) {
    console.error("❌ Failed to setup database:", err.message);
  }
}

setupDatabase();
