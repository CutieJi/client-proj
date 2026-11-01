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

function cellText(value) {
  if (value && typeof value === "object") {
    if (value.result !== undefined) return cellText(value.result);
    if (value.text !== undefined) return String(value.text).trim();
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || "").join("").trim();
  }
  return String(value ?? "").trim();
}

function cellNumber(value, fallback = 0) {
  const raw = cellText(value).replace(/[₱,\s]/g, "");
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

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
      const itemNumber = cellNumber(row.getCell(6).value);
      const sku = cellText(row.getCell(7).value);
      const name = cellText(row.getCell(8).value);
      const category = cellText(row.getCell(9).value);
      const description = cellText(row.getCell(10).value);
      const supplierCost = cellNumber(row.getCell(11).value);
      const supplier = cellText(row.getCell(12).value);
      const brand = cellText(row.getCell(13).value);
      const otherDetails = cellText(row.getCell(14).value);
      const sellingPrice = cellNumber(row.getCell(15).value);
      const reorderPoint = cellNumber(row.getCell(16).value);
      const beginInv = cellNumber(row.getCell(17).value);

      if (name) {
        items.push({
          item_number: itemNumber,
          begin_inventory: beginInv,
          name,
          category: category || "General",
          description,
          supplier,
          supplier_cost: supplierCost,
          brand,
          variant: "",
          other_details: otherDetails,
          sku: sku || "",
          unit: "piece",
          quantity: beginInv,
          unit_price: sellingPrice,
          low_stock_threshold: reorderPoint,
          notes: ""
        });
      }
    }
  });

  console.log(`Extracted ${items.length} items from Excel.`);
  if (items.length === 0) return;

  const chunkSize = 100;
  const existingItems = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("inventory_items")
      .select("id,name,category,sku").range(from, from + 999);
    if (error) throw new Error(`Could not read existing inventory: ${error.message}`);
    existingItems.push(...data);
    if (data.length < 1000) break;
  }

  const normalize = value => String(value || "").trim().toLowerCase();
  const bySku = new Map(), byNameCategory = new Map();
  for (const existing of existingItems) {
    if (existing.sku) {
      const key = normalize(existing.sku);
      bySku.set(key, [...(bySku.get(key) || []), existing]);
    }
    const key = `${normalize(existing.name)}|${normalize(existing.category)}`;
    byNameCategory.set(key, [...(byNameCategory.get(key) || []), existing]);
  }

  const updates = [], inserts = [], matchedIds = new Set();
  for (const item of items) {
    const skuMatches = item.sku ? bySku.get(normalize(item.sku)) || [] : [];
    const identityMatches = byNameCategory.get(`${normalize(item.name)}|${normalize(item.category)}`) || [];
    const matches = skuMatches.length ? skuMatches : identityMatches;
    if (matches.length > 1) {
      throw new Error(`Multiple existing inventory items match "${item.name}". Resolve duplicate SKU/name records before importing.`);
    }
    if (!matches.length) {
      inserts.push(item);
      continue;
    }
    if (matchedIds.has(matches[0].id)) {
      throw new Error(`More than one spreadsheet row matches inventory item "${item.name}". Resolve duplicate masterfile rows before importing.`);
    }
    matchedIds.add(matches[0].id);
    const update = { ...item, id: matches[0].id };
    delete update.quantity;
    updates.push(update);
  }

  for (let i = 0; i < updates.length; i += chunkSize) {
    const { error } = await supabase.from("inventory_items")
      .upsert(updates.slice(i, i + chunkSize), { onConflict: "id" });
    if (error) throw new Error(`Could not update existing inventory: ${error.message}`);
  }
  for (let i = 0; i < inserts.length; i += chunkSize) {
    const { error } = await supabase.from("inventory_items").insert(inserts.slice(i, i + chunkSize));
    if (error) throw new Error(`Could not insert new inventory: ${error.message}`);
  }

  console.log(`Finished processing inventory. Added: ${inserts.length}; updated: ${updates.length}. Existing stock quantities were preserved.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
