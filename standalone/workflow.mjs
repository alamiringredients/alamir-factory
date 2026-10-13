//#region lib/production.ts
var required = (v, label) => {
	if (typeof v !== "string" || !v.trim() || v.length > 160) throw Error("أدخل " + label);
	return v.trim();
};
var quantity = (v) => {
	const n = Number(v);
	if (v === "" || v == null || !Number.isFinite(n) || n <= 0 || n > 1e9) throw Error("الكمية يجب أن تكون أكبر من صفر");
	return n;
};
var day = (v) => {
	const s = required(v, "التاريخ");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw Error("تاريخ غير صحيح");
	return s;
};
var productionNumber = (id) => "PI01-" + String(id).padStart(7, "0");
var productionBatch = (id) => "PB-" + String(id).padStart(7, "0");
var decodeOrder = (r) => ({
	...r,
	number: productionNumber(r.id),
	batch: productionBatch(r.id),
	data: typeof r.data === "string" ? JSON.parse(r.data) : r.data
});
async function productionOperation(db, u, b) {
	const now = (/* @__PURE__ */ new Date()).toISOString(), op = b.action, permissions = {
		production_create: ["production"],
		production_shift: ["production"],
		production_close_shift: ["production"],
		production_packaging: ["production", "warehouse"],
		production_confirm: ["production", "warehouse"],
		production_quality: ["quality"],
		production_close: ["production"]
	};
	if (!permissions[op] || u.role !== "admin" && !permissions[op].includes(u.role)) throw Error("لا توجد صلاحية لتنفيذ إجراء الإنتاج");
	if (op === "production_create") {
		const from = day(b.from), to = new Date(Date.parse(from) + 6 * 864e5).toISOString().slice(0, 10);
		const data = {
			type: "PI01",
			code: required(b.code, "كود المنتج نصف المصنع"),
			name: required(b.name, "وصف المنتج"),
			target: quantity(b.target),
			from,
			to,
			createdAt: now,
			createdBy: u.email,
			shifts: [],
			packaging: [],
			confirmations: [],
			history: [{
				at: now,
				by: u.email,
				action: "إنشاء أمر أسبوعي"
			}]
		};
		return {
			ok: true,
			orderId: (await db.run("INSERT INTO production_orders(demo,version,status,data) VALUES (?,1,?,?)", [
				b.demo === true ? 1 : 0,
				"open",
				JSON.stringify(data)
			])).id
		};
	}
	if (!Number.isSafeInteger(b.orderId) || !Number.isSafeInteger(b.version)) throw Error("رقم أمر غير صالح");
	const raw = await db.first("SELECT * FROM production_orders WHERE id=?", [b.orderId]);
	if (!raw) throw Error("أمر الإنتاج غير موجود");
	if (raw.version !== b.version) throw Error("تم تحديث الأمر من مستخدم آخر. حدّث الصفحة وأعد المحاولة");
	if (raw.status !== "open") throw Error("أمر الإنتاج مغلق");
	const order = decodeOrder(raw), d = order.data;
	let action = "", status = "open";
	const openShift = () => {
		const s = d.shifts.find((s) => s.id === b.shiftId);
		if (!s || s.closedAt) throw Error("اختر شفتًا مفتوحًا");
		return s;
	};
	if (op === "production_shift") {
		const date = day(b.day), name = required(b.name, "اسم الشفت");
		if (date < d.from || date > d.to) throw Error("يوم الشفت خارج أسبوع الأمر");
		if (date > new Intl.DateTimeFormat("en-CA", {
			timeZone: "Africa/Cairo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		}).format(/* @__PURE__ */ new Date())) throw Error("لا يمكن فتح شفت ليوم لم يبدأ بعد");
		if (d.shifts.some((s) => s.day === date && s.name.toLowerCase() === name.toLowerCase())) throw Error("هذا الشفت مسجل لنفس اليوم");
		d.shifts.push({
			id: "SH-" + (d.shifts.length + 1),
			name,
			day: date,
			openedAt: now,
			openedBy: u.email,
			closedAt: null
		});
		d.executionStart = d.executionStart || now;
		action = "فتح الشفت " + name;
	}
	if (op === "production_close_shift") {
		const s = openShift();
		s.closedAt = now;
		s.closedBy = u.email;
		action = "إغلاق الشفت " + s.name;
	}
	if (op === "production_packaging") {
		const s = openShift();
		d.packaging.push({
			id: "MAT-" + (d.packaging.length + 1),
			shiftId: s.id,
			day: s.day,
			code: required(b.code, "كود مادة التعبئة"),
			name: required(b.name, "وصف مادة التعبئة"),
			quantity: quantity(b.quantity),
			unit: required(b.unit, "الوحدة"),
			batch: required(b.batch, "باتش المادة"),
			location: required(b.location, "موقع التخزين"),
			at: now,
			by: u.email
		});
		action = "صرف مواد تعبئة";
	}
	if (op === "production_confirm") {
		const s = openShift();
		if (!["main", "byproduct"].includes(b.kind)) throw Error("اختر نوع الناتج");
		d.confirmations.push({
			id: "CF-" + (d.confirmations.length + 1),
			shiftId: s.id,
			day: s.day,
			kind: b.kind,
			code: b.kind === "main" ? d.code : required(b.code, "كود الناتج الجانبي"),
			name: b.kind === "main" ? d.name : required(b.name, "وصف الناتج الجانبي"),
			quantity: quantity(b.quantity),
			batch: order.batch,
			stock: b.kind === "main" ? "Quality Stock" : "Unrestricted Stock",
			at: now,
			by: u.email,
			decision: null
		});
		action = "تأكيد إنتاج " + (b.kind === "main" ? "أساسي" : "جانبي");
	}
	if (op === "production_quality") {
		const c = d.confirmations.find((c) => c.id === b.confirmationId && c.kind === "main");
		if (!c || c.decision) throw Error("التأكيد غير موجود أو تم فحصه بالفعل");
		if (!["A", "R"].includes(b.decision)) throw Error("اختر A أو R");
		c.decision = b.decision;
		c.qualityAt = now;
		c.qualityBy = u.email;
		c.inspection = "PQ-" + order.id + "-" + c.id;
		c.stock = b.decision === "A" ? "Unrestricted Stock" : "Rejected Stock";
		if (b.decision === "A") {
			c.colorId = required(b.colorId, "كود اللون");
			c.colorDescription = required(b.colorDescription, "وصف اللون");
			c.packagingId = required(b.packagingId, "كود العبوة");
			c.packagingDescription = required(b.packagingDescription, "وصف العبوة");
			c.packedCode = d.code + c.colorId + c.packagingId;
			c.packedDescription = c.decision + c.colorDescription + c.packagingDescription;
		} else c.reason = required(b.reason, "سبب الرفض");
		action = "فحص جودة " + c.id;
	}
	if (op === "production_close") {
		if (!d.confirmations.length) throw Error("لا توجد كميات إنتاج مسجلة");
		if (d.shifts.some((s) => !s.closedAt)) throw Error("أغلق الشفتات المفتوحة أولًا");
		if (d.confirmations.some((c) => c.kind === "main" && !c.decision)) throw Error("استكمل جودة الدفعات قبل إغلاق الأمر");
		d.closedAt = now;
		status = "closed";
		action = "إغلاق أمر الإنتاج";
	}
	d.history.push({
		at: now,
		by: u.email,
		action
	});
	if (!(await db.run(`UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND version=?${op === "production_close" ? " AND NOT EXISTS (SELECT 1 FROM tickets WHERE json_extract(data,'$.productionOrderId')=? AND status<>'done')" : ""}`, [
		JSON.stringify(d),
		status,
		raw.id,
		b.version,
		...op === "production_close" ? [raw.id] : []
	])).changes) throw Error("تعذر الحفظ: الأمر تغير أو توجد شحنات لم يكتمل وزنها");
	return {
		ok: true,
		orderId: raw.id
	};
}
async function productionLink(db, row, b) {
	const parts = String(b.orderShift || "").split(":");
	const id = Number(parts[0]);
	if (!Number.isSafeInteger(id) || id < 1) throw Error("اختر أمر الإنتاج والشفت");
	const r = await db.first("SELECT * FROM production_orders WHERE id=? AND demo=?", [id, row.demo]);
	if (!r || r.status !== "open") throw Error("أمر الإنتاج غير متاح");
	const o = decodeOrder(r), shift = o.data.shifts.find((s) => s.id === parts[1] && !s.closedAt);
	if (!shift) throw Error("الشفت غير متاح أو تم إغلاقه");
	return {
		order: o.number,
		productionOrderId: o.id,
		shiftId: shift.id,
		shiftName: shift.name,
		productionDay: shift.day
	};
}
var linkGuard = " AND EXISTS (SELECT 1 FROM production_orders p,json_each(p.data,'$.shifts') s WHERE p.id=? AND p.demo=? AND p.status='open' AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.closedAt') IS NULL)";
var master_default = {
	fruits: [
		["طماطم صيفى", "300000"],
		["فراولة مجهزة", "300001"],
		["فراولة خام", "300002"],
		["جوافة", "300003"],
		["مانجو", "300004"],
		["فلفل أحمر حار", "300005"],
		["مشمش", "300006"]
	],
	trucks: [
		["ربع نقل", 2e3],
		["جامبو", 6e3],
		["نقل", 12e4],
		["مقطورة", 24e4]
	],
	suppliers: [
		["الشركة الزراعية 0", "110000"],
		["الشركة الزراعية 1", "110001"],
		["الشركة الزراعية 2", "110002"],
		["الشركة الزراعية 3", "110003"],
		["الشركة الزراعية 4", "110004"],
		["الشركة الزراعية 5", "110005"],
		["الشركة الزراعية 6", "110006"],
		["الشركة الزراعية 7", "110007"],
		["الشركة الزراعية 8", "110008"],
		["الشركة الزراعية 9", "110009"],
		["الشركة الزراعية 10", "110010"],
		["الشركة الزراعية 11", "110011"],
		["الشركة الزراعية 12", "110012"],
		["الشركة الزراعية 13", "110013"],
		["الشركة الزراعية 14", "110014"],
		["أخرى", "199999"],
		["تجمبع فرشة", "200000"]
	]
};
//#endregion
//#region lib/catalog.ts
var english = [
	"Tomatoes Fruit (Summer)",
	"Fruit Strawberry ( Prepared )",
	"Fruit Strawberry (Kham)",
	"Fruit Guava",
	"Fruit Mango",
	"Hot Chilli Fruit",
	"Apricot Fruit"
];
var defaultCatalog = {
	suppliers: master_default.suppliers.map(([name, code]) => ({
		id: "s" + code,
		name,
		code
	})),
	fruits: master_default.fruits.map(([name, code], i) => ({
		id: "f" + code,
		name,
		code,
		en: english[i]
	})),
	trucks: master_default.trucks.map(([name, weight], i) => ({
		id: "t" + i,
		name,
		weight
	})),
	prices: []
};
function validateCatalog(c) {
	if (!c || typeof c !== "object") throw Error("بيانات أساسية غير صالحة");
	const clean = (v) => {
		if (typeof v !== "string" || !v.trim() || v.length > 160) throw Error("أكمل الحقول النصية المطلوبة");
		return v.trim();
	};
	const result = {};
	for (const kind of [
		"suppliers",
		"fruits",
		"trucks",
		"prices"
	]) {
		if (!Array.isArray(c[kind]) || c[kind].length > 5e3) throw Error("قائمة غير صالحة");
		result[kind] = c[kind].map((r) => {
			const id = clean(r.id);
			if (kind === "prices") {
				const from = clean(r.from), to = clean(r.to), price = Number(r.price);
				for (const date of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error("تاريخ غير صالح");
				if (from > to) throw Error("تاريخ من يجب ألا يتجاوز تاريخ إلى");
				if (r.price === "" || !Number.isFinite(price) || price < 0 || price > 1e7) throw Error("سعر الكيلو غير صالح");
				return {
					id,
					fruitId: clean(r.fruitId),
					from,
					to,
					price
				};
			}
			const name = clean(r.name);
			if (kind === "trucks") {
				const weight = Number(r.weight);
				if (r.weight === "" || !Number.isFinite(weight) || weight <= 0 || weight > 1e9) throw Error("وزن السيارة يجب أن يكون أكبر من صفر");
				return {
					id,
					name,
					weight
				};
			}
			return {
				id,
				name,
				code: clean(r.code),
				...kind === "fruits" ? { en: clean(r.en) } : {}
			};
		});
		for (const field of kind === "prices" ? ["id"] : kind === "trucks" ? ["id", "name"] : [
			"id",
			"name",
			"code"
		]) {
			const vals = result[kind].map((r) => r[field].toLowerCase());
			if (new Set(vals).size !== vals.length) throw Error("يوجد كود أو اسم مكرر في البيانات الأساسية");
		}
	}
	for (const p of result.prices) {
		if (!result.fruits.some((f) => f.id === p.fruitId)) throw Error("صنف السعر غير موجود");
		if (result.prices.some((q) => q.id !== p.id && q.fruitId === p.fruitId && p.from <= q.to && q.from <= p.to)) throw Error("فترات أسعار نفس الصنف متداخلة. تاريخ البداية والنهاية مشمولان.");
	}
	return result;
}
function catalogLists(c) {
	return {
		suppliers: c.suppliers.map((r) => [r.name, r.code]),
		fruits: c.fruits.map((r) => [
			r.name,
			r.code,
			r.en
		]),
		trucks: c.trucks.map((r) => [r.name, r.weight])
	};
}
function priceSnapshot(c, fruitCode, now) {
	const fruit = c.fruits.find((f) => f.code === fruitCode);
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Cairo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).format(new Date(now));
	const p = c.prices.find((p) => p.fruitId === fruit?.id && p.from <= date && p.to >= date);
	return {
		unitPrice: p?.price ?? null,
		priceFrom: p?.from ?? null,
		priceTo: p?.to ?? null,
		priceDate: date,
		currency: "EGP"
	};
}
//#endregion
//#region lib/workflow.ts
var roles = {
	admin: "مدير النظام",
	security: "الاستقبال والأمن",
	quality: "الجودة",
	scale: "الميزان",
	production: "الإنتاج",
	warehouse: "المخازن",
	viewer: "متابعة وتقارير"
};
var statuses = {
	quality: "انتظار الجودة",
	gross: "انتظار الوزن القائم",
	unload: "انتظار الإنتاج",
	empty: "انتظار الوزن الفارغ",
	done: "مكتملة",
	rejected: "مرفوضة"
};
var stages = [
	[
		"arrival",
		"1.1",
		"الاستقبال"
	],
	[
		"quality",
		"1.2",
		"الجودة"
	],
	[
		"gross",
		"1.3",
		"الوزن القائم"
	],
	[
		"unload",
		"1.4",
		"الإنتاج"
	],
	[
		"empty",
		"1.5",
		"الوزن الفارغ"
	]
];
function documentNumber(kind, id) {
	if (!Number.isSafeInteger(id) || id < 1) throw Error("رقم سجل غير صالح");
	return {
		ticket: "FR",
		inspection: "QI",
		order: "OP"
	}[kind] + "-" + String(id).padStart(7, "0");
}
function text(v, label) {
	if (typeof v !== "string" || !v.trim() || v.trim().length > 160) throw Error("أدخل " + label + " بشكل صحيح");
	return v.trim();
}
function num(v, label, min = 0, max = 1e9) {
	if (v === "" || v === null || v === void 0 || !Number.isFinite(Number(v)) || Number(v) < min || Number(v) > max) throw Error("قيمة غير صالحة: " + label);
	return Number(v);
}
function pick(v, list, label) {
	const x = list.find((r) => r[0] === v);
	if (!x) throw Error("اختر " + label + " من القائمة");
	return x;
}
function createData(b, now, catalog) {
	const lists = catalog ? catalogLists(catalog) : master_default;
	const fruit = pick(b.fruit, lists.fruits, "الصنف"), supplier = pick(b.supplier, lists.suppliers, "المورد"), truck = pick(b.truck, lists.trucks, "السيارة");
	const containers = num(b.containers, "عدد العبوات", 0, 1e6);
	if (!Number.isInteger(containers)) throw Error("عدد العبوات يجب أن يكون صحيحًا");
	return {
		...catalog ? priceSnapshot(catalog, String(fruit[1]), now) : {},
		fruitEn: fruit[2] || "",
		plateKey: normalizePlate(text(b.plate, "لوحة السيارة")),
		fruit: fruit[0],
		fruitCode: fruit[1],
		supplier: supplier[0],
		supplierCode: supplier[1],
		truck: truck[0],
		estimate: truck[1],
		plate: text(b.plate, "لوحة السيارة"),
		driver: text(b.driver, "السائق"),
		origin: text(b.origin, "المنشأ"),
		containers,
		unit: "KG",
		arrival: now
	};
}
function transition(row, action, b, role, now, link) {
	if (role !== "admin" && {
		quality: "quality",
		gross: "scale",
		unload: "production",
		empty: "scale"
	}[action] !== role) throw Error("لا توجد صلاحية لتنفيذ هذا الإجراء");
	if (row.status !== action) throw Error("المرحلة تغيرت أو الإجراء غير متاح");
	const d = { ...row.data };
	let status = "";
	if (action === "quality") {
		if (!["A", "R"].includes(b.decision)) throw Error("اختر A أو R");
		d.decision = b.decision;
		d.inspection = d.inspection || documentNumber("inspection", row.id);
		d.deduction = b.deduction === void 0 || b.deduction === null || String(b.deduction).trim() === "" ? 0 : num(b.deduction, "نسبة الخصم", 0, 100);
		d.qualityAt = now;
		d.reason = b.decision === "R" ? text(b.reason, "سبب الرفض") : "";
		status = b.decision === "R" ? "rejected" : "gross";
	} else if (action === "gross") {
		d.gross = num(b.gross, "الوزن القائم", .001);
		d.grossAt = now;
		status = "unload";
	} else if (action === "unload") {
		if (b.confirm !== true) throw Error("أكد إتمام التفريغ");
		if (link) Object.assign(d, link);
		else d.order = d.order || documentNumber("order", row.id);
		d.unloadAt = now;
		status = "empty";
	} else if (action === "empty") {
		d.empty = num(b.empty, "الوزن الفارغ", .001);
		if (d.empty >= d.gross) throw Error("الوزن الفارغ يجب أن يكون أقل من الوزن القائم");
		d.emptyAt = now;
		d.net = d.gross - d.empty;
		d.payable = d.net * (1 - d.deduction / 100);
		d.amount = d.unitPrice == null ? null : Math.round(d.payable * d.unitPrice * 100) / 100;
		status = "done";
	} else throw Error("إجراء غير معروف");
	return {
		data: d,
		status
	};
}
var plateReplacements = [
	[" ", ""],
	["	", ""],
	["\n", ""],
	["\r", ""],
	["\xA0", ""],
	["-", ""],
	...Array.from("٠١٢٣٤٥٦٧٨٩").map((c, i) => [c, String(i)]),
	...Array.from("۰۱۲۳۴۵۶۷۸۹").map((c, i) => [c, String(i)])
];
function normalizePlate(value) {
	let key = value.toLowerCase();
	for (const [a, b] of plateReplacements) key = key.split(a).join(b);
	if (!key) throw Error("أدخل رقم لوحة صالح");
	return key;
}
var createTicketSql = `INSERT INTO tickets (demo,version,status,data,history,created_at) SELECT ?,1,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE demo=? AND coalesce(json_extract(data,'$.plateKey'),${plateReplacements.reduce((sql, [a, b]) => `replace(${sql},'${a}','${b}')`, "lower(json_extract(data,'$.plate'))")})=? AND created_at>?)`;
var duplicatePlateMessage = "السيارة مسجلة بالفعل خلال آخر 4 ساعات. افتح التذكرة الحالية لاستكمال الإجراءات، أو أعد التسجيل بعد انقضاء المدة.";
//#endregion
export { createData, createTicketSql, decodeOrder, defaultCatalog, documentNumber, duplicatePlateMessage, linkGuard, normalizePlate, productionLink, productionOperation, roles, stages, statuses, text, transition, validateCatalog };
