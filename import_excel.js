/**
 * Script to import inventory items from "INVENTORY MAIN.xlsx" into Supabase.
 * Usage: node import_excel.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const excelPath = path.join(process.env.USERPROFILE || "C:\\Users\\Ningmei", "Downloads", "INVENTORY MAIN.xlsx");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

if (!fs.existsSync(excelPath)) {
  console.error(`Excel file not found at: ${excelPath}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log(`Reading Excel file: ${excelPath}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);

  const sheet = workbook.getWorksheet("MASTERFILE MANAGEMENT");
  if (!sheet) {
    console.error("Sheet 'MASTERFILE MANAGEMENT' not found.");
    process.exit(1);
  }

  const items = [];
  let headerRowIndex = null;

  sheet.eachRow((row, rowNumber) => {
    const values = row.values;
    if (values.includes("Items") || values.includes("Product Sku/no#")) {
      headerRowIndex = rowNumber;
      return;
    }

    if (headerRowIndex && rowNumber > headerRowIndex) {
      const sku = String(row.getCell(7).value || "").trim();
      const name = String(row.getCell(8).value || "").trim();
      const category = String(row.getCell(9).value || "").trim();
      const description = String(row.getCell(10).value || "").trim();
      const supplier = String(row.getCell(12).value || "").trim();
      const brand = String(row.getCell(13).value || "").trim();
      const otherDetails = String(row.getCell(14).value || "").trim();
      const sellingPrice = Number(row.getCell(15).value || 0);
      const reorderPoint = Number(row.getCell(16).value || 5);
      const beginInv = Number(row.getCell(17).value || 0);

      if (name) {
        items.push({
          name,
          category: category || "General",
          brand: brand || supplier || "",
          variant: otherDetails || description || "",
          sku: sku || "",
          unit: "piece",
          quantity: isNaN(beginInv) ? 0 : Math.max(0, beginInv),
          unit_price: isNaN(sellingPrice) ? 0 : Math.max(0, sellingPrice),
          low_stock_threshold: isNaN(reorderPoint) ? 5 : Math.max(1, reorderPoint),
          notes: description !== name ? description : ""
        });
      }
    }
  });

  console.log(`Extracted ${items.length} items from Excel.`);
  if (items.length === 0) return;

  const chunkSize = 100;
  let inserted = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const { error } = await supabase.from("inventory_items").upsert(chunk, { onConflict: "name,category" });
    if (error) {
      // If composite key is not set, standard insert
      const { error: insertError } = await supabase.from("inventory_items").insert(chunk);
      if (insertError) {
        console.warn(`Chunk ${i / chunkSize + 1} insert note:`, insertError.message);
      } else {
        inserted += chunk.length;
      }
    } else {
      inserted += chunk.length;
    }
  }

  console.log(`Finished processing inventory items. Inserted/updated: ${inserted}`);
}

run().catch(console.error);

