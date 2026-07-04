import db from './db.js';

async function diagnose() {
  console.log("Checking Turso Database Connection...");
  try {
    const result = await db.execute("SELECT 1");
    console.log("✅ Basic connection test passed!");

    const tablesResult = await db.execute("SELECT name FROM sqlite_master WHERE type='table';");
    console.log("📋 Tables found in your database:");
    if (tablesResult.rows.length === 0) {
      console.log("⚠️ No tables found! Did you execute the SQL script in your Turso Studio?");
    } else {
      tablesResult.rows.forEach(row => console.log(`  - ${row.name}`));
    }
  } catch (err) {
    console.error("❌ Database connection error details:", err.message);
  }
}

diagnose();
