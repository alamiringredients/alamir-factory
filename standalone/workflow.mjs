//#region lib/access.ts
var roles = {
	admin: "مدير النظام",
	security: "الاستقبال والأمن",
	quality: "الجودة",
	scale: "الميزان",
	production: "مشرف الإنتاج",
	warehouse: "المخازن — صلاحية عامة",
	planner: "تخطيط الإنتاج",
	store_main: "أمين المخزن الرئيسي",
	store_production: "أمين مخزن الإنتاج",
	store_finished: "أمين مخزن المنتج التام",
	plant_manager: "مدير المصنع",
	maintenance: "الصيانة",
	cost_control: "مراقبة التكاليف",
	viewer: "متابعة وتقارير"
};
var actualRole = (u) => u.actualRole || u.role;
function warehouseAllowed(role, code) {
	return !role.startsWith("store_") || role === "store_production" && code === "PROD" || role === "store_finished" && code === "FG" || role === "store_main" && !["PROD", "FG"].includes(code);
}
function operator(u, action) {
	const role = actualRole(u);
	let mapped = role;
	const planner = [
		"production_create",
		"production_requirement",
		"production_bom",
		"production_rate"
	];
	const factory = [
		"production_close",
		"production_change_decide",
		"production_balance_decide"
	];
	if (role === "planner") {
		if (!planner.includes(action) && !action.startsWith("control_")) throw Error("هذه الحركة ليست من صلاحية التخطيط");
		mapped = "production";
	}
	if (role === "plant_manager") {
		if (!factory.includes(action) && !action.startsWith("control_")) throw Error("هذه الحركة تحتاج مسؤول القسم المختص");
		mapped = "admin";
	}
	if (role.startsWith("store_")) {
		mapped = ["inventory_accept", "inventory_transfer_accept"].includes(action) && role === "store_production" ? "production" : "warehouse";
		if (role === "store_main" && [
			"inventory_issue",
			"inventory_prepare_bom",
			"inventory_return",
			"inventory_accept",
			"inventory_reserve"
		].includes(action)) throw Error("الصرف على الأمر من مسؤولية مخزن الإنتاج");
		if (role === "store_finished" && ![
			"cycle_receive",
			"cycle_deliver",
			"cycle_customer",
			"cycle_container_return",
			"inventory_labels",
			"inventory_label_link",
			"inventory_transfer",
			"inventory_transfer_accept",
			"inventory_transfer_cancel"
		].includes(action) && !action.startsWith("control_")) throw Error("هذه الحركة ليست من صلاحية مخزن المنتج التام");
	}
	return {
		...u,
		actualRole: role,
		role: mapped
	};
}
function assertWarehouse(u, code) {
	if (!warehouseAllowed(actualRole(u), code)) throw Error("المخزن خارج نطاق صلاحيتك");
}
function assertApprover(u, createdBy, demo) {
	if (actualRole(u) === "admin") return;
	if (!["plant_manager"].includes(actualRole(u))) throw Error("الاعتماد من صلاحية مدير المصنع");
	if (!demo && u.email === createdBy) throw Error("منشئ الطلب لا يعتمد طلبه في سجل التشغيل");
}
//#endregion
//#region lib/read-scope.ts
function scopedOperations(input, tickets, catalog, u) {
	const role = actualRole(u);
	if (role === "admin") return {
		inventory: input,
		orders: [...input.orders].sort((a, b) => b.id - a.id),
		tickets,
		catalog
	};
	const inv = structuredClone(input), s = inv.state, c = s.control || {}, scope = (c.userScopes || []).find((r) => r.email === u.email.toLowerCase()), lineRestricted = !!scope?.lines?.length, warehouseRestricted = !!scope?.warehouses?.length || role.startsWith("store_");
	const warehouse = (w) => warehouseAllowed(role, w) && (!scope?.warehouses?.length || scope.warehouses.includes(w));
	c.userScopes = (c.userScopes || []).filter((r) => r.email === u.email.toLowerCase());
	s.fastOperations = [];
	if (!lineRestricted && !warehouseRestricted) return {
		inventory: inv,
		orders: inv.orders.sort((a, b) => b.id - a.id),
		tickets,
		catalog
	};
	const orders = inv.orders.filter((o) => !lineRestricted || scope.lines.includes(o.data.lineId)), orderIds = new Set(orders.map((o) => o.id));
	const lots = inv.lots.filter((l) => warehouse(l.warehouse) && (!l.orderId || orderIds.has(l.orderId))), lotIds = new Set(lots.map((l) => l.id));
	const visibleTickets = warehouse("PROD") ? tickets.filter((t) => !lineRestricted || orderIds.has(t.data.productionOrderId) || orders.some((o) => (o.data.receipts || []).some((r) => r.ticketId === t.id))) : [], ticketIds = new Set(visibleTickets.map((t) => t.id));
	const byOrder = (r) => orderIds.has(r.orderId), byLot = (r) => lotIds.has(r.lotId), issues = s.issues.filter((i) => byOrder(i) && byLot(i)), issueIds = new Set(issues.map((i) => i.id)), byIssue = (r) => issueIds.has(r.issueId);
	const deliveries = s.deliveries.filter(byLot), deliveryIds = new Set(deliveries.map((d) => d.id));
	const state = {
		materials: s.materials,
		salePrices: s.salePrices,
		warehouses: s.warehouses,
		entries: s.entries.filter((r) => lotIds.has(r.id)),
		issues,
		returns: s.returns.filter(byIssue),
		preparations: s.preparations.filter((r) => byOrder(r) && byLot(r)),
		reservations: s.reservations.filter((r) => byOrder(r) && byLot(r)),
		adjustments: s.adjustments.filter(byLot),
		warehouseReceipts: s.warehouseReceipts.filter(byLot),
		incomingInspections: s.incomingInspections.filter(byLot),
		consumptions: s.consumptions.filter((r) => byIssue(r) && (!r.outputLotId || lotIds.has(r.outputLotId))),
		packs: s.packs.filter((r) => byIssue(r) && lotIds.has(r.outputLotId)),
		returnRequests: s.returnRequests.filter(byIssue),
		supplyRequests: warehouse("PROD") ? s.supplyRequests.filter(byOrder) : [],
		deliveries,
		customers: warehouse("FG") ? s.customers : [],
		containerReturns: s.containerReturns.filter((r) => deliveryIds.has(r.deliveryId)),
		settlements: s.settlements.filter((r) => deliveryIds.has(r.deliveryId)),
		transfers: (s.transfers || []).filter((t) => (warehouse(t.fromWarehouse) || warehouse(t.toWarehouse)) && (!t.material?.orderId || orderIds.has(t.material.orderId))).map((t) => ({
			...t,
			allocations: (t.allocations || []).filter(byOrder)
		})),
		operationShifts: (s.operationShifts || []).filter(byOrder),
		automaticFillingJobs: (s.automaticFillingJobs || []).filter((j) => orderIds.has(j.parentOrderId) && (!j.sourceLotId || lotIds.has(j.sourceLotId))),
		labelRuns: (s.labelRuns || []).filter((r) => r.lotId ? lotIds.has(r.lotId) : r.orderId ? byOrder(r) && warehouse("FG") : !lineRestricted && warehouse("FG")),
		fruitLocations: Object.fromEntries(Object.entries(s.fruitLocations || {}).filter(([k]) => lotIds.has(k))),
		history: [],
		fastOperations: []
	};
	const machines = (c.machines || []).filter((m) => !lineRestricted || scope.lines.includes(m.kind === "line" ? m.id : m.lineId)), machineIds = new Set(machines.map((m) => m.id));
	state.control = {
		machines,
		userScopes: c.userScopes,
		closedDays: c.closedDays || [],
		costCentres: c.costCentres || [],
		incidents: (c.incidents || []).filter((r) => machineIds.has(r.machineId)),
		equipmentChecks: (c.equipmentChecks || []).filter((r) => machineIds.has(r.machineId)),
		equipmentReviews: (c.equipmentReviews || []).filter((r) => machineIds.has(r.machineId)),
		cip: (c.cip || []).filter((r) => !lineRestricted || scope.lines.includes(r.lineId)),
		releases: (c.releases || []).filter(byOrder),
		requests: (c.requests || []).filter((r) => r.orderId ? byOrder(r) : r.lotId ? byLot(r) : r.by === u.email),
		trace: (c.trace || []).filter((r) => byOrder(r) && lotIds.has(r.outputLotId) && byIssue(r)),
		audit: (c.audit || []).filter((r) => r.by === u.email)
	};
	for (const o of orders) {
		const d = o.data;
		d.confirmations = (d.confirmations || []).filter((x) => lotIds.has("P-" + o.id + "-" + x.id));
		const ids = new Set(d.confirmations.map((x) => x.id));
		d.weights = (d.weights || []).filter((r) => ids.has(r.confirmationId));
		d.receipts = (d.receipts || []).filter((r) => ticketIds.has(r.ticketId));
		d.history = (d.history || []).filter((r) => r.by === u.email);
		if (warehouseRestricted) {
			d.processBalance = null;
			d.balanceHistory = [];
			d.handovers = [];
			d.waste = [];
			d.packaging = [];
		}
	}
	const balances = [];
	for (const l of lots) {
		let b = balances.find((b) => b.code === l.code && b.warehouse === l.warehouse && b.unit === l.unit);
		if (!b) {
			b = {
				code: l.code,
				name: l.name,
				category: l.category,
				warehouse: l.warehouse,
				unit: l.unit,
				balance: 0,
				reserved: 0,
				available: 0,
				pending: 0,
				rejected: 0
			};
			balances.push(b);
		}
		for (const k of [
			"balance",
			"reserved",
			"available"
		]) b[k] += Number(l[k] || 0);
		if (l.quality === "H") b.pending += l.balance;
		if (l.quality === "R") b.rejected += l.balance;
	}
	return {
		inventory: {
			...inv,
			state,
			orders,
			lots,
			balances,
			readRestricted: true
		},
		orders: orders.sort((a, b) => b.id - a.id),
		tickets: visibleTickets,
		catalog,
		readRestricted: true
	};
}
//#endregion
//#region lib/cairo-time.ts
function cairoLocalISO(value) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error("توقيت القاهرة غير صحيح");
	const desired = Date.parse(value + ":00Z");
	if (!Number.isFinite(desired)) throw Error("توقيت القاهرة غير صحيح");
	let at = desired;
	const fmt = new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Africa/Cairo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23"
	});
	for (let n = 0; n < 3; n++) {
		const shown = fmt.format(new Date(at)).replace(" ", "T");
		const delta = desired - Date.parse(shown + ":00Z");
		at += delta;
		if (!delta) break;
	}
	if (fmt.format(new Date(at)).replace(" ", "T") !== value) throw Error("التوقيت غير موجود بسبب تغيير الساعة");
	return new Date(at).toISOString();
}
//#endregion
//#region lib/auto-shifts.ts
var dateFormat = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Africa/Cairo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
});
var timeFormat = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Africa/Cairo",
	hour: "2-digit",
	hourCycle: "h23"
});
var nextDay = (day, delta) => new Date(Date.parse(day + "T12:00:00Z") + delta * 864e5).toISOString().slice(0, 10);
function boundary(day, time) {
	try {
		return cairoLocalISO(day + "T" + time);
	} catch (error) {
		if (time !== "00:00") throw error;
		for (let minute = 1; minute <= 120; minute++) {
			const clock = String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
			try {
				return cairoLocalISO(day + "T" + clock);
			} catch {}
		}
		throw error;
	}
}
function operatingShift(at = (/* @__PURE__ */ new Date()).toISOString()) {
	const date = new Date(at);
	if (!Number.isFinite(date.valueOf())) throw Error("وقت الحركة غير صالح");
	const calendarDay = dateFormat.format(date), hour = Number(timeFormat.format(date)), slot = hour < 8 ? 3 : hour < 16 ? 1 : 2, day = hour < 8 ? nextDay(calendarDay, -1) : calendarDay;
	const startDay = slot === 3 ? nextDay(day, 1) : day, endDay = slot === 2 || slot === 3 ? nextDay(day, 1) : day;
	const start = slot === 1 ? "08:00" : slot === 2 ? "16:00" : "00:00", end = slot === 1 ? "16:00" : slot === 2 ? "00:00" : "08:00";
	return {
		id: "AUTO-" + day + "-" + slot,
		slot,
		name: slot === 1 ? "صباحي — 08:00 إلى 16:00" : slot === 2 ? "مسائي — 16:00 إلى 00:00" : "ليلي — 00:00 إلى 08:00",
		day,
		calendarDay,
		startAt: boundary(startDay, start),
		endAt: boundary(endDay, end),
		automatic: true,
		timeZone: "Africa/Cairo"
	};
}
function shiftMetadata(at = (/* @__PURE__ */ new Date()).toISOString()) {
	const s = operatingShift(at);
	return {
		shiftId: s.id,
		shiftName: s.name,
		shiftSlot: s.slot,
		day: s.day,
		calendarDay: s.calendarDay,
		shiftStart: s.startAt,
		shiftEnd: s.endAt,
		automaticShift: true,
		timeZone: s.timeZone
	};
}
function mergeOrderShifts(state, o, at = (/* @__PURE__ */ new Date()).toISOString()) {
	o.data.shifts ||= [];
	for (const s of state.operationShifts || []) if (s.orderId === o.id && !o.data.shifts.some((x) => x.id === s.id)) o.data.shifts.push({ ...s });
	for (const s of o.data.shifts) if (s.automatic && !s.closedAt && s.endAt <= at) {
		s.closedAt = s.endAt;
		s.closedBy = "SYSTEM";
		s.autoEnded = true;
	}
	return o;
}
function ensureAutoShift(inv, o, u, now, saveTo = "inventory") {
	const clock = operatingShift(now);
	if (clock.day < o.data.from || clock.day > o.data.to) throw Error("توقيت الحركة خارج فترة أمر التشغيل: يوم التشغيل الحالي " + clock.day + "، وفترة الأمر من " + o.data.from + " إلى " + o.data.to + "؛ راجع مسؤول التشغيل لتصحيح فترة الأمر قبل الاستلام أو الإنتاج");
	mergeOrderShifts(inv.state, o, now);
	let s = o.data.shifts.find((s) => s.id === clock.id);
	if (s?.closedAt) throw Error("الشيفت الحالي مغلق؛ راجع مسؤول التشغيل");
	if (!s) {
		s = {
			...clock,
			orderId: o.id,
			openedAt: now,
			openedBy: u.email,
			closedAt: null,
			notes: ""
		};
		o.data.shifts.push(s);
	}
	if (saveTo === "inventory") {
		inv.state.operationShifts ||= [];
		if (!inv.state.operationShifts.some((r) => r.orderId === o.id && r.id === s.id)) inv.state.operationShifts.push({ ...s });
	}
	o.data.executionStart ||= now;
	return s;
}
function tagNewMovements(state, now) {
	const tag = shiftMetadata(now);
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (!Array.isArray(value) && value.at === now && value.by && !value.automaticShift) Object.assign(value, tag);
		for (const v of Object.values(value)) if (v && typeof v === "object") visit(v);
	};
	visit(state);
}
//#endregion
//#region lib/bulk-receipt-policy.ts
function bulkReceiptPolicy(state, order, confirmation) {
	const c = confirmation, bulk = order.data.type === "Bulk" && c.kind === "main", lotId = "P-" + order.id + "-" + c.id;
	const received = (state.warehouseReceipts || []).some((r) => r.lotId === lotId);
	const moved = (state.issues || []).some((r) => r.lotId === lotId) || (state.transfers || []).some((r) => r.sourceLotId === lotId && !r.cancelledAt);
	const directBulk = bulk && c.directBulk === true && !received && moved;
	const restored = bulk && c.directBulk === true && !received && !moved;
	return {
		directBulk,
		requiresWarehouseReceipt: !directBulk && (c.requiresWarehouseReceipt === true || restored),
		warehouse: directBulk ? "PROD" : restored ? "SEMI" : c.warehouse || order.data.warehouse || (order.data.type === "Filling" ? "FG" : "SEMI")
	};
}
//#endregion
//#region lib/fruit-receiving.ts
function fruitReceiptLocation(state, id) {
	const lotId = "T-" + id;
	if (state.fruitLocations?.[lotId]) return state.fruitLocations[lotId];
	const receipt = (state.warehouseReceipts || []).find((r) => r.lotId === lotId);
	if (receipt) return receipt.warehouse;
	const previous = (state.issues || []).find((i) => i.lotId === lotId) || (state.preparations || []).find((p) => p.lotId === lotId);
	if (previous) return previous.warehouse || "RAW";
	const transfer = (state.transfers || []).find((t) => t.sourceLotId === lotId);
	if (transfer) return transfer.fromWarehouse;
	if ((state.reservations || []).some((r) => r.lotId === lotId) || (state.adjustments || []).some((a) => a.lotId === lotId)) return "RAW";
	return "PROD";
}
//#endregion
//#region lib/equipment.ts
var technicalStates = {
	ready: "جاهزة",
	running: "تعمل",
	down: "متوقفة",
	maintenance: "تحت الصيانة"
};
var equipmentDecisions = {
	A: "معتمدة للتشغيل",
	H: "بانتظار فحص الجودة",
	R: "موقوفة بواسطة الجودة",
	none: "لم يسجل فحص للمعدة"
};
function equipmentRows(inv, orders = inv.orders || []) {
	const c = inv.state.control || {}, machines = c.machines || [], checks = c.equipmentChecks || [], reviews = c.equipmentReviews || [];
	return machines.map((m) => {
		const lineId = m.kind === "line" ? m.id : m.lineId, line = machines.find((x) => x.id === lineId), incidents = (c.incidents || []).filter((x) => x.machineId === m.id), active = incidents.filter((x) => !x.closedAt), check = [...checks].reverse().find((x) => x.machineId === m.id), review = [...reviews].reverse().find((x) => x.machineId === m.id), cip = [...c.cip || []].reverse().find((x) => x.lineId === lineId), running = orders.filter((o) => o.status === "open" && o.data.lineId === lineId && o.data.shifts?.some((s) => !s.closedAt));
		return {
			...m,
			lineId,
			lineName: line?.name || "",
			technical: m.status || "ready",
			quality: m.qualityHold ? m.qualityStatus || "H" : review?.decision || "none",
			hold: Boolean(m.qualityHold),
			active,
			check,
			review,
			cip,
			running,
			lastRepair: [...incidents].reverse().find((x) => x.closedAt)
		};
	});
}
function lineBlockers(inv, lineId) {
	const rows = equipmentRows(inv), line = rows.find((m) => m.id === lineId && m.kind === "line");
	if (!line) return ["حدد خط الإنتاج"];
	const messages = [];
	for (const m of rows.filter((m) => m.id === lineId || m.lineId === lineId)) {
		if (!["ready", "running"].includes(m.technical) || m.active.length) messages.push(m.name + " · " + (technicalStates[m.technical] || "متوقفة"));
		if (m.hold) messages.push(m.name + " · " + equipmentDecisions[m.quality]);
	}
	if (line.cip && line.cip.decision !== "A") messages.push(line.name + " · " + (line.cip.decision === "R" ? "CIP مرفوض" : "CIP بانتظار الجودة"));
	return [...new Set(messages)];
}
//#endregion
//#region lib/operations-state.ts
function controls(d) {
	d.control ||= {};
	for (const key of [
		"releases",
		"requests",
		"machines",
		"incidents",
		"cip",
		"costCentres",
		"trace",
		"closedDays",
		"audit",
		"userScopes",
		"equipmentChecks",
		"equipmentReviews"
	]) d.control[key] ||= [];
	return d.control;
}
var isReleased = (inv, o) => o.data.cycleVersion < 4 || !o.data.cycleVersion || controls(inv.state).releases.some((r) => r.orderId === o.id && r.decision === "A");
function assertReleased(inv, o) {
	if (!isReleased(inv, o)) throw Error("اعتمد إطلاق الأمر من شاشة الاعتمادات قبل التشغيل");
}
var dateInCairo = (v) => new Intl.DateTimeFormat("en-CA", {
	timeZone: "Africa/Cairo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
}).format(new Date(v));
var closedDay = (inv, day) => controls(inv.state).closedDays.some((d) => d.day === day && !d.reopenedAt);
function assertDayOpen(inv, day) {
	if (closedDay(inv, day)) throw Error("يوم التشغيل مغلق؛ اطلب إعادة فتحه من مدير المصنع");
}
function expired(l, day) {
	return Boolean(l.expiryDate && l.expiryDate < day);
}
function assertUsable(l, day) {
	if (expired(l, day)) throw Error("انتهت صلاحية الباتش ولا يسمح بصرفه أو تحويله");
}
function assertLineReady(inv, o) {
	if (o.data.cycleVersion < 4 && !o.data.lineId) return;
	const reasons = lineBlockers(inv, o.data.lineId);
	if (reasons.length) throw Error("خط الإنتاج غير جاهز: " + reasons.join(" / "));
}
function canControl(role, kind) {
	if (role === "admin") return true;
	return ({
		plan: ["planner", "production"],
		approve: ["plant_manager"],
		adjust: [
			"warehouse",
			"store_main",
			"store_production",
			"store_finished",
			"production"
		],
		maintain: ["maintenance", "plant_manager"],
		equipment: [
			"production",
			"maintenance",
			"plant_manager"
		],
		reportEquipment: [
			"production",
			"quality",
			"maintenance",
			"plant_manager"
		],
		cip: ["production", "maintenance"],
		quality: ["quality"],
		trace: ["production"],
		day: ["plant_manager"]
	}[kind] || []).includes(role);
}
function assertScope(inv, u, scope) {
	if (actualRole(u) === "admin") return;
	const r = controls(inv.state).userScopes.find((r) => r.email === u.email.toLowerCase());
	if (!r) return;
	if (scope.lineId && r.lines?.length && !r.lines.includes(scope.lineId) || scope.warehouse && r.warehouses?.length && !r.warehouses.includes(scope.warehouse)) throw Error("الخط أو المخزن خارج نطاق المستخدم");
}
//#endregion
//#region lib/quality-approval.ts
function validateQualityApproval(b) {
	const terminal = ["A", "R"].includes(b.decision);
	const name = String(b.inspectorName || "").trim();
	const report = String(b.inspectionReport || "").trim();
	if (name.length > 160 || report.length > 4e3) throw Error("نص نتيجة الفحص أو اسم القائم بالفحص طويل");
	if (terminal) {
		if (!name) throw Error("أدخل اسم القائم بالفحص");
		if (!report) throw Error("أدخل نتيجة الفحص الكاملة");
		if (!["PASS", "FAIL"].includes(b.conformity)) throw Error("حدد نتيجة المطابقة قبل اعتماد الجودة");
		if (b.confirmQuality !== true) throw Error("أكد اكتمال نتائج الفحص وقرار الجودة");
	}
	return {
		qualitySchemaVersion: 5,
		inspectorName: name,
		inspectionReport: report,
		qualityConfirmed: terminal && b.confirmQuality === true
	};
}
function receivingReady(data) {
	const q = data.receivingQuality;
	return Boolean(q && q.decision === "A" && q.allowProceed === true && q.reviewerName && q.confirmed === true);
}
//#endregion
//#region lib/material-inspection.ts
var inspectionFields = [
	["appearance", "المظهر"],
	["containerIntegrity", "سلامة العبوة"],
	["length", "الطول"],
	["width", "العرض"],
	["height", "الارتفاع"],
	["thickness", "السمك"],
	["diameter", "القطر"],
	["leakage", "الثقوب / التسريب"],
	["unitWeight", "وزن الوحدة"],
	["physicalAnalyst", "محلل الفحص الطبيعي"],
	["concentration", "التركيز"],
	["ph", "pH"],
	["purity", "النقاوة"],
	["solubility", "الذوبان"],
	["impurities", "الشوائب"],
	["specificGravity", "الكثافة النوعية"],
	["chemicalAnalyst", "محلل الفحص الكيميائي"],
	["mouldYeast", "الفطر والخمائر"],
	["coliform", "Coliform"],
	["tpc", "TPC"],
	["microAnalyst", "محلل الفحص الميكروبي"],
	["coa", "COA"],
	["coc", "COC"],
	["workability", "قابلية التشغيل"],
	["reviewedBy", "المراجع"]
];
var incomingDataFields = [
	["supplier", "المورد"],
	["carNumber", "رقم السيارة"],
	["lotNo", "رقم اللوت"],
	["productionDate", "تاريخ الإنتاج"],
	["expiryDate", "تاريخ الصلاحية"]
];
var materialSpecifications = {
	drums: {
		name: "براميل",
		height: "950 ± 5 mm",
		thickness: "0.8 mm",
		diameter: "527 mm Lower / 570 mm Upper",
		unitWeight: "12 ± 1 Kg with cover and closing ring",
		workability: "Accepted"
	},
	poly: {
		name: "أكياس بولي إيثيلين",
		length: "200 cm",
		width: "97 cm",
		thickness: "50 µm",
		unitWeight: "215.3 g",
		leakage: "ND",
		workability: "Accepted"
	},
	aseptic: {
		name: "أكياس أسيبتك",
		length: "156.5 cm ±5 mm",
		width: "89 cm ±5 mm",
		thickness: "340 µm ±7%",
		unitWeight: "100 g ±7%",
		leakage: "ND",
		workability: "Accepted"
	},
	pallets: {
		name: "بالتات",
		length: "110 cm",
		width: "110 cm",
		height: "14 cm",
		thickness: "not less than 1.8 mm/ board",
		leakage: "ND",
		workability: "Accepted"
	},
	stretch: {
		name: "استرتش",
		leakage: "ND",
		workability: "Accepted"
	},
	caustic: {
		name: "صودا كاوية سائلة",
		concentration: "48-50 %",
		ph: "14 (as supplied)",
		solubility: "Miscible with water",
		specificGravity: "1.48 - 1.52"
	},
	citric: {
		name: "حمض الستريك اللامائي",
		concentration: "0.995",
		ph: "2 + 0.5",
		solubility: "Readily soluble in water",
		tpc: "Not detected",
		mouldYeast: "Not detected",
		coliform: "Not detected"
	},
	nitric: {
		name: "حمض النيتريك",
		ph: "<1",
		solubility: "Miscible",
		specificGravity: "1.48 - 1.52"
	},
	ascorbic: {
		name: "حمض الأسكوربيك",
		concentration: "95-100 %",
		ph: "2.1-2.6",
		tpc: "1000 Cfu/g Max",
		mouldYeast: "100 Cfu/g Max",
		coliform: "Not detected"
	}
};
function materialProfile(m) {
	if (m?.qcProfile) return m.qcProfile;
	return {
		"200000": "drums",
		"200010": "drums",
		"200003": "pallets",
		"200005": "poly",
		"300010": "ascorbic"
	}[m?.code] || "";
}
function requiredInspectionFields(profile) {
	const spec = materialSpecifications[profile] || {};
	return inspectionFields.filter(([key]) => key in spec);
}
function validateMaterialInspection(b) {
	const results = {};
	for (const [key] of inspectionFields) {
		const value = b["test_" + key];
		if (value != null && String(value).length > 160) throw Error("نتيجة الفحص طويلة");
		results[key] = String(value || "").trim();
	}
	if (b.decision === "A") {
		for (const [key, label] of requiredInspectionFields(b.qcProfile)) if (!results[key]) throw Error("استكمل نتيجة الفحص: " + label);
	}
	return {
		...validateQualityApproval(b),
		results,
		specification: materialSpecifications[b.qcProfile] || null,
		profile: b.qcProfile || "",
		notes: String(b.notes || "").slice(0, 160)
	};
}
var production_master_default = {
	source: "Eng. Islam Master Data_update1.xlsx",
	revision: "2026-10-17",
	materials: [
		{
			"code": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200004",
			"name": "Sticker",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"category": "packaging",
			"unit": "M",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200010",
			"name": "Used Drum-Conical Steel blue 220 Ltr.",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200011",
			"name": "Used Clamping ring gal. 220L conical drum",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "200012",
			"name": "Used Steel Lid blue 220 Ltr. conical drum",
			"category": "packaging",
			"unit": "PC",
			"warehouse": "PACK",
			"sourceType": "Packaging",
			"phantom": false
		},
		{
			"code": "300000",
			"name": "Tomatoes Fruit (Summer)",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300001",
			"name": "Fruit Strawberry ( Prepared )",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300002",
			"name": "Fruit Strawberry (Kham)",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300003",
			"name": "Fruit Guava",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300004",
			"name": "Fruit Mango",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300005",
			"name": "Hot Chilli Fruit",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300006",
			"name": "Apricot Fruit",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "300010",
			"name": "Ascorbic Acid E300 204004661",
			"category": "raw",
			"unit": "KG",
			"warehouse": "RAW",
			"sourceType": "Raw Material",
			"phantom": false
		},
		{
			"code": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500004",
			"name": "A Tomato Conc. B36-38CB",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500005",
			"name": "Strawberry Pulp Seeds 1.5 W.O Clx",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500006",
			"name": "Strawberry Pulp Seedless 0.6 W Clx",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500007",
			"name": "Guava Pulp 0.6",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500008",
			"name": "Mango Pulp 0.6",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500009",
			"name": "Hot Chili Puree Concentrate 12-14",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500010",
			"name": "Hot Chili Puree Concentrate 18-20",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500011",
			"name": "Apricot Pulp",
			"category": "semi",
			"unit": "KG",
			"warehouse": "SEMI",
			"sourceType": "BULK",
			"phantom": false
		},
		{
			"code": "500000.01.0100",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500000.02.0100",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500000.03.0100",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500000.04.0100",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500000.05.0100",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500001.01.0100",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500001.02.0100",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500001.03.0100",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500001.04.0100",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500001.05.0100",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500002.01.0100",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500002.02.0100",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500002.03.0100",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500002.04.0100",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500002.05.0100",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500003.01.0100",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500003.02.0100",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500003.03.0100",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500003.04.0100",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500003.05.0100",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500004.01.0100",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500004.02.0100",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500004.03.0100",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500004.04.0100",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500004.05.0100",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500005.00.0140",
			"name": "Strawberry Pulp _Seeds_A190U",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500006.00.0140",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500007.00.0130",
			"name": "Guava Pulp 0.6- A200C",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500008.00.0120",
			"name": "Mango Pulp 0.6-A215",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500009.00.0130",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500010.00.0130",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "500011.00.0130",
			"name": "Apricot Pulp A200",
			"category": "finished",
			"unit": "KG",
			"warehouse": "FG",
			"sourceType": "Finished Product",
			"phantom": false
		},
		{
			"code": "0.00099.990",
			"name": "LP-Tomatoes Paste",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "0.00099.991",
			"name": "Lp-Strawberry Pulp",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "0.00099.992",
			"name": "Lp-Guava Pulp",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "0.00099.993",
			"name": "Lp-Mango Pulp",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "0.00099.994",
			"name": "Lp- Hot Chilli Puree",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "0.00099.996",
			"name": "Lp-Apricot Pulp",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Low Brix",
			"phantom": false
		},
		{
			"code": "900000.00.00",
			"name": "Tomato Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Co-Product",
			"phantom": false
		},
		{
			"code": "900001.00.00",
			"name": "Strawberry Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "By- Product",
			"phantom": false
		},
		{
			"code": "900003.00.00",
			"name": "Guava Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "By- Product",
			"phantom": false
		},
		{
			"code": "900004.00.00",
			"name": "Mango Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Co-Product",
			"phantom": false
		},
		{
			"code": "900005.00.00",
			"name": "Hot Chilli Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "By- Product",
			"phantom": false
		},
		{
			"code": "900006.00.00",
			"name": "Lp- Hot Chilli Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "By- Product",
			"phantom": false
		},
		{
			"code": "900007.00.00",
			"name": "Apricot Peel",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "By- Product",
			"phantom": false
		},
		{
			"code": "900008.00.00",
			"name": "Mango Stones",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Co-Product",
			"phantom": false
		},
		{
			"code": "900009.00.00",
			"name": "Apricot Stones",
			"category": "byproduct",
			"unit": "KG",
			"warehouse": "OTHER",
			"sourceType": "Co-Product",
			"phantom": false
		}
	],
	boms: [
		{
			"code": "500000.01.0100",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500000",
					"name": "A Tomato Conc. B28-30CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 2,
					"originalCode": "500000"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 3,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 4,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 5,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 6,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 7,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 8,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 9,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 10,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 11,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 12,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"base": 920,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300000",
					"name": "Tomatoes Fruit (Summer)",
					"quantity": 6900,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "6900",
					"coproduct": false,
					"sourceRow": 13,
					"originalCode": "300000"
				},
				{
					"item": "0020",
					"code": "0.00099.990",
					"name": "LP-Tomatoes Paste",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 14,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "900000.00.00",
					"name": "Tomato Peel",
					"quantity": -345,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "-345",
					"coproduct": true,
					"sourceRow": 15,
					"originalCode": "900000.00.00"
				}
			]
		},
		{
			"code": "500000.02.0100",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500000",
					"name": "A Tomato Conc. B28-30CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 16,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 17,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 18,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 19,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 20,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 21,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 22,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 23,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 24,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 25,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 26,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500000.03.0100",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500000",
					"name": "A Tomato Conc. B28-30CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 27,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 28,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 29,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 30,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 31,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 32,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 33,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 34,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 35,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 36,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 37,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500000.04.0100",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500000",
					"name": "A Tomato Conc. B28-30CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 38,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 39,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 40,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 41,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 42,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 43,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 44,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 45,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 46,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 47,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 48,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500000.05.0100",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500000",
					"name": "A Tomato Conc. B28-30CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 49,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 50,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 51,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 52,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 53,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 54,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 55,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 56,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 57,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 58,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 59,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500001.01.0100",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500001",
					"name": "A Tomato Conc. B28-30HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 60,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 61,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 62,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 63,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 64,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 65,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 66,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 67,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 68,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 69,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 70,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"base": 920,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300000",
					"name": "Tomatoes Fruit (Summer)",
					"quantity": 6900,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "6900",
					"coproduct": false,
					"sourceRow": 71,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "0.00099.990",
					"name": "LP-Tomatoes Paste",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 72,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "900000.00.00",
					"name": "Tomato Peel",
					"quantity": -345,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "-345",
					"coproduct": true,
					"sourceRow": 73,
					"originalCode": "900000.00.00"
				}
			]
		},
		{
			"code": "500001.02.0100",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500001",
					"name": "A Tomato Conc. B28-30HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 74,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 75,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 76,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 77,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 78,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 79,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 80,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 81,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 82,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 83,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 84,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500001.03.0100",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500001",
					"name": "A Tomato Conc. B28-30HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 85,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 86,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 87,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 88,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 89,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 90,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 91,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 92,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 93,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 94,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 95,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500001.04.0100",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500001",
					"name": "A Tomato Conc. B28-30HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 96,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 97,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 98,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 99,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 100,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 101,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 102,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 103,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 104,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 105,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 106,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500001.05.0100",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500001",
					"name": "A Tomato Conc. B28-30HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 107,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 108,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 109,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 110,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 111,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 112,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 113,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 114,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 115,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 116,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 117,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500002.01.0100",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500002",
					"name": "A Tomato Conc. B30-32CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 118,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 119,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 120,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 121,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 122,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 123,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 124,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 125,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 126,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 127,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 128,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"base": 920,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300000",
					"name": "Tomatoes Fruit (Summer)",
					"quantity": 6900,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "6900",
					"coproduct": false,
					"sourceRow": 129,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "0.00099.990",
					"name": "LP-Tomatoes Paste",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 130,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "900000.00.00",
					"name": "Tomato Peel",
					"quantity": -345,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "-345",
					"coproduct": true,
					"sourceRow": 131,
					"originalCode": "900000.00.00"
				}
			]
		},
		{
			"code": "500002.02.0100",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500002",
					"name": "A Tomato Conc. B30-32CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 132,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 133,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 134,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 135,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 136,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 137,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 138,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 139,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 140,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 141,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 142,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500002.03.0100",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500002",
					"name": "A Tomato Conc. B30-32CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 143,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 144,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 145,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 146,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 147,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 148,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 149,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 150,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 151,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 152,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 153,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500002.04.0100",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500002",
					"name": "A Tomato Conc. B30-32CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 154,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 155,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 156,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 157,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 158,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 159,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 160,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 161,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 162,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 163,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 164,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500002.05.0100",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500002",
					"name": "A Tomato Conc. B30-32CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 165,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 166,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 167,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 168,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 169,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 170,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 171,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 172,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 173,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 174,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 175,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500003.01.0100",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500003",
					"name": "A Tomato Conc. B30-32HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 176,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 177,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 178,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 179,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 180,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 181,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 182,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 183,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 184,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 185,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 186,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"base": 920,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300000",
					"name": "Tomatoes Fruit (Summer)",
					"quantity": 6900,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "6900",
					"coproduct": false,
					"sourceRow": 187,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "0.00099.990",
					"name": "LP-Tomatoes Paste",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 188,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "900000.00.00",
					"name": "Tomato Peel",
					"quantity": -345,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "-345",
					"coproduct": true,
					"sourceRow": 189,
					"originalCode": "900000.00.00"
				}
			]
		},
		{
			"code": "500003.02.0100",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500003",
					"name": "A Tomato Conc. B30-32HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 190,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 191,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 192,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 193,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 194,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 195,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 196,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 197,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 198,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 199,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 200,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500003.03.0100",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500003",
					"name": "A Tomato Conc. B30-32HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 201,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 202,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 203,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 204,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 205,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 206,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 207,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 208,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 209,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 210,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 211,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500003.04.0100",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500003",
					"name": "A Tomato Conc. B30-32HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 212,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0010",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 213,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 214,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 215,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 216,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 217,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 218,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 219,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 220,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 221,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 222,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500003.05.0100",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500003",
					"name": "A Tomato Conc. B30-32HB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 223,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 224,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 225,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 226,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 227,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 228,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 229,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 230,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 231,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 232,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 233,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500004.01.0100",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500004",
					"name": "A Tomato Conc. B36-38CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 234,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0010",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 235,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 236,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 237,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 238,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 239,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 240,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 241,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 242,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 243,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 244,
					"originalCode": "0.00099.990"
				}
			]
		},
		{
			"code": "500004",
			"name": "A Tomato Conc. B36-38CB",
			"base": 920,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300000",
					"name": "Tomatoes Fruit (Summer)",
					"quantity": 6900,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "6900",
					"coproduct": false,
					"sourceRow": 245,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0020",
					"code": "0.00099.990",
					"name": "LP-Tomatoes Paste",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 246,
					"originalCode": "0.00099.990"
				},
				{
					"item": "0030",
					"code": "900000.00.00",
					"name": "Tomato Peel",
					"quantity": -345,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "-345",
					"coproduct": true,
					"sourceRow": 247,
					"originalCode": "900000.00.00"
				}
			]
		},
		{
			"code": "500004.02.0100",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500004",
					"name": "A Tomato Conc. B36-38CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 248,
					"originalCode": "500004"
				},
				{
					"item": "0010",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 249,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 250,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 251,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 252,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 253,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 254,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 255,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 256,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 257,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 258,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500004.03.0100",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500004",
					"name": "A Tomato Conc. B36-38CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 259,
					"originalCode": "500004"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 260,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 261,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 262,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 263,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 264,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 265,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 266,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 267,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 268,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 269,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500004.04.0100",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500004",
					"name": "A Tomato Conc. B36-38CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 270,
					"originalCode": "500004"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 271,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 272,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 273,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 274,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 275,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 276,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 277,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 278,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 279,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 280,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500004.05.0100",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"base": 920,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500004",
					"name": "A Tomato Conc. B36-38CB",
					"quantity": 920,
					"unit": "KG",
					"originalUnit": "KG",
					"originalQuantity": "920",
					"coproduct": false,
					"sourceRow": 281,
					"originalCode": "500004"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 282,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 283,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 284,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 285,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 286,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 287,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 288,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 289,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 290,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 291,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500005.00.0140",
			"name": "Strawberry Pulp _Seeds_A190U",
			"base": 760,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500005",
					"name": "Strawberry Pulp Seeds 1.5 W.O Clx",
					"quantity": 760,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "760",
					"coproduct": false,
					"sourceRow": 292,
					"originalCode": "500005"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 293,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 294,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 295,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 296,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 297,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 298,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 299,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 300,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 301,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 302,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500005",
			"name": "Strawberry Pulp Seeds 1.5 W.O Clx",
			"base": 760,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300001",
					"name": "Fruit Strawberry ( Prepared )",
					"quantity": 823.36,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "823.36",
					"coproduct": false,
					"sourceRow": 303,
					"originalCode": "300001"
				},
				{
					"item": "0020",
					"code": "0.00099.991",
					"name": "Lp-Strawberry Pulp",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 304,
					"originalCode": "0.00099.991"
				},
				{
					"item": "0030",
					"code": "900001.00.00",
					"name": "Strawberry Peel",
					"quantity": -6.175,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "6.175-",
					"coproduct": true,
					"sourceRow": 305,
					"originalCode": "900001.00.00"
				}
			]
		},
		{
			"code": "500006.00.0140",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"base": 760,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500006",
					"name": "Strawberry Pulp Seedless 0.6 W Clx",
					"quantity": 760,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "760",
					"coproduct": false,
					"sourceRow": 306,
					"originalCode": "500006"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 307,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 308,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 309,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 310,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 311,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 312,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 313,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 314,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 315,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 316,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500006",
			"name": "Strawberry Pulp Seedless 0.6 W Clx",
			"base": 760,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300002",
					"name": "Fruit Strawberry (Kham)",
					"quantity": 837.64,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "837.64",
					"coproduct": false,
					"sourceRow": 317,
					"originalCode": "300002"
				},
				{
					"item": "0020",
					"code": "0.00099.991",
					"name": "Lp-Strawberry Pulp",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 318,
					"originalCode": "0.00099.991"
				},
				{
					"item": "0030",
					"code": "900001.00.00",
					"name": "Strawberry Peel",
					"quantity": 25.128,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "25.128",
					"coproduct": true,
					"sourceRow": 319,
					"originalCode": "900001.00.00"
				}
			]
		},
		{
			"code": "500007.00.0130",
			"name": "Guava Pulp 0.6- A200C",
			"base": 800,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500007",
					"name": "Guava Pulp 0.6",
					"quantity": 800,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "800.000",
					"coproduct": false,
					"sourceRow": 320,
					"originalCode": "500007"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 321,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 322,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 323,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 324,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 325,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 326,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 327,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 328,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 329,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 330,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500007",
			"name": "Guava Pulp 0.6",
			"base": 800,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300003",
					"name": "Fruit Guava",
					"quantity": 849.6,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "849.6",
					"coproduct": false,
					"sourceRow": 331,
					"originalCode": "300003"
				},
				{
					"item": "0020",
					"code": "300010",
					"name": "Ascorbic Acid E300 204004661",
					"quantity": 20,
					"unit": "G",
					"originalUnit": "GM",
					"originalQuantity": "20.000",
					"coproduct": false,
					"sourceRow": 332,
					"originalCode": "300010"
				},
				{
					"item": "0030",
					"code": "0.00099.992",
					"name": "Lp-Guava Pulp",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 333,
					"originalCode": "0.00099.992"
				},
				{
					"item": "0040",
					"code": "900003.00.00",
					"name": "Guava Peel",
					"quantity": -21.24,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "21.240-",
					"coproduct": true,
					"sourceRow": 334,
					"originalCode": "999999.00.00"
				}
			]
		},
		{
			"code": "500008.00.0120",
			"name": "Mango Pulp 0.6-A215",
			"base": 860,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500008",
					"name": "Mango Pulp 0.6",
					"quantity": 860,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "860.000",
					"coproduct": false,
					"sourceRow": 335,
					"originalCode": "500008"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 336,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 337,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 338,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 339,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 340,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 341,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 342,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 343,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 344,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 345,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500008",
			"name": "Mango Pulp 0.6",
			"base": 860,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300004",
					"name": "Fruit Mango",
					"quantity": 880,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "880",
					"coproduct": false,
					"sourceRow": 346,
					"originalCode": "300004"
				},
				{
					"item": "0020",
					"code": "300010",
					"name": "Ascorbic Acid E300 204004661",
					"quantity": 28,
					"unit": "G",
					"originalUnit": "GM",
					"originalQuantity": "28.000",
					"coproduct": false,
					"sourceRow": 347,
					"originalCode": "300010"
				},
				{
					"item": "0030",
					"code": "0.00099.993",
					"name": "Lp-Mango Pulp",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 348,
					"originalCode": "0.00099.993"
				},
				{
					"item": "0070",
					"code": "900004.00.00",
					"name": "Mango Peel",
					"quantity": -14.25,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "14.250-",
					"coproduct": true,
					"sourceRow": 349,
					"originalCode": "900004.00.00"
				},
				{
					"item": "0080",
					"code": "900008.00.00",
					"name": "Mango Stones",
					"quantity": -57,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "57.000-",
					"coproduct": true,
					"sourceRow": 350,
					"originalCode": "999999.00.01"
				}
			]
		},
		{
			"code": "500009.00.0130",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"base": 800,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500009",
					"name": "Hot Chili Puree Concentrate 12-14",
					"quantity": 800,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "800.000",
					"coproduct": false,
					"sourceRow": 351,
					"originalCode": "500009"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 352,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 353,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 354,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 355,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 356,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 357,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 358,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 359,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 360,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 361,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500009",
			"name": "Hot Chili Puree Concentrate 12-14",
			"base": 800,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [{
				"item": "0010",
				"code": "300005",
				"name": "Hot Chilli Fruit",
				"quantity": 1850,
				"unit": "KG",
				"originalUnit": "KGM",
				"originalQuantity": "1,850.000",
				"coproduct": false,
				"sourceRow": 362,
				"originalCode": "300005"
			}, {
				"item": "0030",
				"code": "900005.00.00",
				"name": "Hot Chilli Peel",
				"quantity": -400,
				"unit": "KG",
				"originalUnit": "KGM",
				"originalQuantity": "400.000-",
				"coproduct": true,
				"sourceRow": 363,
				"originalCode": "900005.00.00"
			}]
		},
		{
			"code": "500010.00.0130",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"base": 800,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500010",
					"name": "Hot Chili Puree Concentrate 18-20",
					"quantity": 800,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "800.000",
					"coproduct": false,
					"sourceRow": 364,
					"originalCode": "500010"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 365,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 366,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 367,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 368,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 369,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 370,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 371,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 372,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 373,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 374,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500010",
			"name": "Hot Chili Puree Concentrate 18-20",
			"base": 800,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [{
				"item": "0010",
				"code": "300005",
				"name": "Hot Chilli Fruit",
				"quantity": 2857,
				"unit": "KG",
				"originalUnit": "KGM",
				"originalQuantity": "2,857.000",
				"coproduct": false,
				"sourceRow": 375,
				"originalCode": "300005"
			}, {
				"item": "0020",
				"code": "900005.00.00",
				"name": "Hot Chilli Peel",
				"quantity": -400,
				"unit": "KG",
				"originalUnit": "KGM",
				"originalQuantity": "400.000-",
				"coproduct": true,
				"sourceRow": 376,
				"originalCode": "900005.00.00"
			}]
		},
		{
			"code": "500011.00.0130",
			"name": "Apricot Pulp A200",
			"base": 800,
			"unit": "KG",
			"process": "Direct Filling",
			"lines": [
				{
					"item": "0010",
					"code": "500011",
					"name": "Apricot Pulp",
					"quantity": 800,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "800",
					"coproduct": false,
					"sourceRow": 377,
					"originalCode": "500011"
				},
				{
					"item": "0020",
					"code": "200000",
					"name": "New Steel drum conical blue 220L 7mm",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 378,
					"originalCode": "200000"
				},
				{
					"item": "0030",
					"code": "200001",
					"name": "New Clamping ring gal. 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 379,
					"originalCode": "200001"
				},
				{
					"item": "0040",
					"code": "200002",
					"name": "New Steel Lid galvanized 220L conical drum",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 380,
					"originalCode": "200002"
				},
				{
					"item": "0050",
					"code": "200003",
					"name": "New Wooden Pallet 110*110Cm.",
					"quantity": 1,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "1",
					"coproduct": false,
					"sourceRow": 381,
					"originalCode": "200003"
				},
				{
					"item": "0060",
					"code": "200004",
					"name": "Sticker",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 382,
					"originalCode": "200004"
				},
				{
					"item": "0070",
					"code": "200005",
					"name": "Polyethylene Bag - (c.200KG-100 micron)",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 383,
					"originalCode": "200005"
				},
				{
					"item": "0080",
					"code": "200006",
					"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 384,
					"originalCode": "200006"
				},
				{
					"item": "0090",
					"code": "200007",
					"name": "Anti Tamper Security Plastic Seal",
					"quantity": 4,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "4",
					"coproduct": false,
					"sourceRow": 385,
					"originalCode": "200007"
				},
				{
					"item": "0100",
					"code": "200008",
					"name": "Polypropylene Plastic Wrapping Strap",
					"quantity": 5,
					"unit": "M",
					"originalUnit": "M",
					"originalQuantity": "5",
					"coproduct": false,
					"sourceRow": 386,
					"originalCode": "200008"
				},
				{
					"item": "0110",
					"code": "200009",
					"name": "Metal Clip for Palett Wrapping Strap",
					"quantity": 8,
					"unit": "PC",
					"originalUnit": "PC",
					"originalQuantity": "8",
					"coproduct": false,
					"sourceRow": 387,
					"originalCode": "200009"
				}
			]
		},
		{
			"code": "500011",
			"name": "Apricot Pulp",
			"base": 800,
			"unit": "KG",
			"process": "Bulk Production",
			"lines": [
				{
					"item": "0010",
					"code": "300006",
					"name": "Apricot Fruit",
					"quantity": 880,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "880",
					"coproduct": false,
					"sourceRow": 388,
					"originalCode": "300006"
				},
				{
					"item": "0020",
					"code": "300010",
					"name": "Ascorbic Acid E300 204004661",
					"quantity": 28,
					"unit": "G",
					"originalUnit": "GM",
					"originalQuantity": "28.000",
					"coproduct": false,
					"sourceRow": 389,
					"originalCode": "300010"
				},
				{
					"item": "0030",
					"code": "0.00099.996",
					"name": "Lp-Apricot Pulp",
					"quantity": -500,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "500.000-",
					"coproduct": true,
					"sourceRow": 390,
					"originalCode": "0.00099.996"
				},
				{
					"item": "0070",
					"code": "900007.00.00",
					"name": "Apricot Peel",
					"quantity": -14.25,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "14.250-",
					"coproduct": true,
					"sourceRow": 391,
					"originalCode": "900007.00.00"
				},
				{
					"item": "0080",
					"code": "900009.00.00",
					"name": "Apricot Stones",
					"quantity": -57,
					"unit": "KG",
					"originalUnit": "KGM",
					"originalQuantity": "57.000-",
					"coproduct": true,
					"sourceRow": 392,
					"originalCode": "999999.00.02"
				}
			]
		}
	],
	conflicts: [],
	corrections: [
		{
			"row": 3,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 4,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 5,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 6,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 7,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 8,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 9,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 10,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 11,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 12,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 16,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 17,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 17,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 18,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 18,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 19,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 19,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 20,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 20,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 21,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 21,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 22,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 22,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 23,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 23,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 24,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 24,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 25,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 25,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 26,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 26,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 27,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 28,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 28,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 29,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 29,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 30,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 30,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 31,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 31,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 32,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 32,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 33,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 33,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 34,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 34,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 35,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 35,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 36,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 36,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 37,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 37,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 38,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 39,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 39,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 40,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 40,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 41,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 41,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 42,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 42,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 43,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 43,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 44,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 44,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 45,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 45,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 46,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 46,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 47,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 47,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 48,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 48,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 49,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500000",
			"name": "A Tomato Conc. B28-30CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 50,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 50,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 51,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 51,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 52,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 52,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 53,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 53,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 54,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 54,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 55,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 55,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 56,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 56,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 57,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 57,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 58,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 58,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 59,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 59,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 60,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 61,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 61,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 62,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 62,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 63,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 63,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 64,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 64,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 65,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 65,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 66,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 66,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 67,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 67,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 68,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 68,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 69,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 69,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 70,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 70,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 71,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "300000",
			"name": "Tomatoes Fruit (Summer)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 74,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 74,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 75,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 75,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 75,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 76,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 76,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 76,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 77,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 77,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 77,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 78,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 78,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 78,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 79,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 79,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 79,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 80,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 80,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 80,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 81,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 81,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 81,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 82,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 82,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 82,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 83,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 83,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 83,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 84,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 84,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 84,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 85,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 85,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 86,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 86,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 86,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 87,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 87,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 87,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 88,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 88,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 88,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 89,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 89,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 89,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 90,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 90,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 90,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 91,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 91,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 91,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 92,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 92,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 92,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 93,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 93,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 93,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 94,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 94,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 94,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 95,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 95,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 95,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 96,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 96,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 97,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 97,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 97,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 98,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 98,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 98,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 99,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 99,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 99,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 100,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 100,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 100,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 101,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 101,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 101,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 102,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 102,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 102,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 103,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 103,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 103,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 104,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 104,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 104,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 105,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 105,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 105,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 106,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 106,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 106,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 107,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500001",
			"name": "A Tomato Conc. B28-30HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 107,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 108,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 108,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 108,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 109,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 109,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 109,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 110,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 110,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 110,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 111,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 111,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 111,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 112,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 112,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 112,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 113,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 113,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 113,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 114,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 114,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 114,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 115,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 115,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 115,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 116,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 116,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 116,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 117,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 117,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 117,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B28-30HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 118,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 118,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 119,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 119,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 119,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 120,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 120,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 120,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 121,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 121,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 121,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 122,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 122,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 122,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 123,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 123,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 123,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 124,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 124,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 124,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 125,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 125,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 125,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 126,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 126,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 126,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 127,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 127,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 127,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 128,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 128,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 128,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 129,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "300000",
			"name": "Tomatoes Fruit (Summer)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 132,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 132,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 133,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 133,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 133,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 134,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 134,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 134,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 135,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 135,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 135,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 136,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 136,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 136,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 137,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 137,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 137,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 138,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 138,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 138,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 139,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 139,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 139,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 140,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 140,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 140,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 141,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 141,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 141,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 142,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 142,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 142,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 143,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 143,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 144,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 144,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 144,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 145,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 145,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 145,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 146,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 146,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 146,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 147,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 147,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 147,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 148,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 148,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 148,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 149,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 149,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 149,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 150,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 150,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 150,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 151,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 151,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 151,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 152,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 152,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 152,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 153,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 153,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 153,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 154,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 154,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 155,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 155,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 155,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 156,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 156,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 156,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 157,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 157,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 157,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 158,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 158,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 158,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 159,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 159,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 159,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 160,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 160,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 160,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 161,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 161,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 161,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 162,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 162,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 162,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 163,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 163,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 163,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 164,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 164,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 164,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 165,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500002",
			"name": "A Tomato Conc. B30-32CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 165,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 166,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 166,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 166,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 167,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 167,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 167,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 168,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 168,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 168,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 169,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 169,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 169,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 170,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 170,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 170,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 171,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 171,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 171,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 172,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 172,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 172,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 173,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 173,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 173,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 174,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 174,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 174,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 175,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 175,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 175,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 176,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 176,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 177,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 177,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 177,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 178,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 178,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 178,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 179,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 179,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 179,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 180,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 180,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 180,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 181,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 181,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 181,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 182,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 182,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 182,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 183,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 183,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 183,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 184,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 184,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 184,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 185,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 185,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 185,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 186,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 186,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 186,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 187,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "300000",
			"name": "Tomatoes Fruit (Summer)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 190,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 190,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 191,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 191,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 191,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 192,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 192,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 192,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 193,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 193,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 193,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 194,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 194,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 194,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 195,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 195,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 195,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 196,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 196,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 196,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 197,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 197,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 197,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 198,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 198,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 198,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 199,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 199,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 199,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 200,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 200,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 200,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 201,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 201,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 202,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 202,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 202,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 203,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 203,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 203,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 204,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 204,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 204,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 205,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 205,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 205,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 206,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 206,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 206,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 207,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 207,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 207,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 208,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 208,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 208,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 209,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 209,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 209,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 210,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 210,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 210,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 211,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 211,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 211,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 212,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 212,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 213,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 213,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 214,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 214,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 214,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 215,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 215,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 215,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 216,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 216,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 216,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 217,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 217,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 217,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 218,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 218,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 218,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 219,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 219,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 219,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 220,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 220,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 220,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 221,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 221,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 221,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 222,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 222,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 222,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 223,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500003",
			"name": "A Tomato Conc. B30-32HB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 223,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 224,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 224,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 224,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 225,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 225,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 225,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 226,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 226,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 226,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 227,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 227,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 227,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 228,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 228,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 228,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 229,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 229,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 229,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 230,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 230,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 230,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 231,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 231,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 231,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 232,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 232,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 232,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 233,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 233,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 233,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B30-32HB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 234,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "500004",
			"name": "A Tomato Conc. B36-38CB",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 234,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 235,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200000",
			"name": "New Steel drum conical blue 220L 7mm",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 235,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 236,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200001",
			"name": "New Clamping ring gal. 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 236,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 236,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 237,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200002",
			"name": "New Steel Lid galvanized 220L conical drum",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 237,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 237,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 238,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200003",
			"name": "New Wooden Pallet 110*110Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 238,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 238,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 239,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200004",
			"name": "Sticker",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 239,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 239,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 240,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200005",
			"name": "Polyethylene Bag - (c.200KG-100 micron)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 240,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 240,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 241,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200006",
			"name": "Plastic Tie Ring Shaped Cable 37 Cm.",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 241,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 241,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 242,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200007",
			"name": "Anti Tamper Security Plastic Seal",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 242,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 242,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 243,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200008",
			"name": "Polypropylene Plastic Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 243,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 243,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 244,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "200009",
			"name": "Metal Clip for Palett Wrapping Strap",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 244,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 244,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.70-1.79DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 245,
			"kind": "كود مكون",
			"old": "0.00099.990",
			"new": "300000",
			"name": "Tomatoes Fruit (Summer)",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 248,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 249,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 250,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 250,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 251,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 251,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 252,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 252,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 253,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 253,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 254,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 254,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 255,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 255,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 256,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 256,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 257,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 257,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 258,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 258,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.80-1.89DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 259,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 260,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 260,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 261,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 261,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 262,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 262,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 263,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 263,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 264,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 264,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 265,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 265,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 266,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 266,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 267,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 267,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 268,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 268,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 269,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 269,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB1.90.1.99DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 270,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 271,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 272,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 272,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 273,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 273,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 274,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 274,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 275,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 275,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 276,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 276,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 277,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 277,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 278,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 278,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 279,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 279,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 280,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 280,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.00-2.09DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 281,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 282,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 282,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 283,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 283,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 284,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 284,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 285,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 285,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 286,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 286,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 287,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 287,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 288,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 288,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 289,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 289,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 290,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 290,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 291,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 291,
			"kind": "وحدة أساس المنتج",
			"old": "PC",
			"new": "KG",
			"name": "A Tomato Conc. B36-38CB2.10-2.19DRM230Kg",
			"reason": "وحدة المنتج من الماستر؛ وحدة المكون محفوظة مستقلة"
		},
		{
			"row": 292,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 293,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 294,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 295,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 296,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 297,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 298,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 299,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 300,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 301,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 302,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _Seeds_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 306,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 307,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 308,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 309,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 310,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 311,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 312,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 313,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 314,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 315,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 316,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Strawberry Pulp _ Seedless_A190U",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 320,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 321,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 322,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 323,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 324,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 325,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 326,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 327,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 328,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 329,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 330,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Guava Pulp 0.6- A200C",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 334,
			"kind": "كود مكون",
			"old": "999999.00.00",
			"new": "900003.00.00",
			"name": "Guava Peel",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 335,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 336,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 337,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 338,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 339,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 340,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 341,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 342,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 343,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 344,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 345,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Mango Pulp 0.6-A215",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 350,
			"kind": "كود مكون",
			"old": "999999.00.01",
			"new": "900008.00.00",
			"name": "Mango Stones",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		},
		{
			"row": 351,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 352,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 353,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 354,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 355,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 356,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 357,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 358,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 359,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 360,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 361,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 12-14 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 364,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 365,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 366,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 367,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 368,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 369,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 370,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 371,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 372,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 373,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 374,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Hot Chili Puree Conc. 18-20 – A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 377,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 378,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 379,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 380,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 381,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 382,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 383,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 384,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 385,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 386,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 387,
			"kind": "نوع الأمر",
			"old": "Bulk Production",
			"new": "Direct Filling",
			"name": "Apricot Pulp A200",
			"reason": "حسب تصنيف المنتج في الماستر"
		},
		{
			"row": 392,
			"kind": "كود مكون",
			"old": "999999.00.02",
			"new": "900009.00.00",
			"name": "Apricot Stones",
			"reason": "تطابق التوصيف أو الكود المكتوب بخانة التوصيف مع الماستر"
		}
	],
	retired: [{
		"code": "400000",
		"name": "New Drum-Conical Steel blue 220 Ltr."
	}, {
		"code": "400001",
		"name": "Used Drum-Conical Steel blue 220 Ltr."
	}]
};
//#endregion
//#region lib/bom.ts
var masterData = {
	...production_master_default,
	conflicts: production_master_default.conflicts
};
function bomPlan(code, target, materials, dataset = masterData) {
	const recipe = dataset.boms.find((r) => r.code === code);
	if (!recipe) return null;
	if (!Number.isFinite(target) || target <= 0) throw Error("أدخل كمية مستهدفة موجبة لحساب مخطط الصرف");
	const inputs = [], outputs = [], warnings = [];
	const visit = (r, amount, path) => {
		if (path.includes(r.code)) throw Error("حلقة في وصفة التصنيع");
		if (r.blockedReasons?.length) throw Error("راجع وصفة " + r.code + ": " + r.blockedReasons.join("؛ "));
		if (!Number.isFinite(r.base) || r.base <= 0) throw Error("الكمية الأساسية غير صالحة");
		for (const l of r.lines) {
			const m = materials.find((m) => m.code === l.code);
			let quantity = l.quantity * amount / r.base;
			const output = quantity < 0 || l.coproduct;
			quantity = Math.abs(quantity);
			if (!m) {
				if (output) {
					outputs.push({
						...l,
						quantity,
						blocked: true
					});
					warnings.push("الكود " + l.code + " معلق لتعارض التوصيف؛ لا يسجل ناتجًا حتى المراجعة");
					continue;
				}
				throw Error("مكون مخطط الصرف غير موجود: " + l.code);
			}
			if (l.unit === "G" && m.unit === "KG") quantity /= 1e3;
			else if (l.unit !== m.unit) throw Error("وحدة مخطط الصرف لا تطابق وحدة الصنف " + l.code);
			if (m.phantom) {
				const child = dataset.boms.find((b) => b.code === m.code);
				if (output || !child) throw Error("راجع مجموعة التعبئة " + m.code);
				visit(child, quantity, [...path, r.code]);
				continue;
			}
			const list = output ? outputs : inputs, existing = list.find((x) => x.code === l.code);
			if (existing) existing.quantity += quantity;
			else list.push({
				code: m.code,
				name: m.name,
				unit: m.unit,
				quantity,
				source: "BOM",
				via: path.length ? r.code : void 0
			});
		}
	};
	const material = materials.find((m) => m.code === code);
	if (!material || recipe.unit !== material.unit) throw Error("وحدة المنتج لا تطابق مخطط الصرف");
	visit(recipe, target, []);
	for (const l of [...inputs, ...outputs]) {
		l.quantity = Math.round(l.quantity * 1e3) / 1e3;
		if (l.quantity <= 0) throw Error("كمية مخطط الصرف أقل من دقة 0.001؛ راجع الكمية المستهدفة");
		if (!l.blocked) l.bomQuantity = l.quantity;
	}
	return {
		source: dataset.source,
		revision: dataset.revision,
		code,
		base: recipe.base,
		unit: recipe.unit,
		target,
		inputs,
		outputs,
		warnings
	};
}
//#endregion
//#region lib/label-batches.ts
function nextOutputBatch(inv, order) {
	const confirmations = order.data.confirmations || [];
	const used = new Set(confirmations.map((c) => c.batch));
	const mainBatches = new Set(confirmations.filter((c) => c.kind === "main" && (c.code || order.data.code) === order.data.code).map((c) => c.batch));
	const printed = (inv.state?.labelRuns || []).find((r) => r.orderId === order.id && r.code === order.data.code && r.batchKind === "planned" && !mainBatches.has(r.batch));
	if (printed) return printed.batch;
	const prefix = (order.batch || "PB-" + String(order.id).padStart(7, "0")) + "-CF-";
	let serial = confirmations.length + 1;
	while (used.has(prefix + serial)) serial++;
	return prefix + serial;
}
function labelBatchChoices(inv, code, orderId) {
	if (!code) return [];
	const orders = (inv.orders || []).filter((o) => o.data.type === "Filling" && o.data.code === code && (!orderId || o.id === Number(orderId)));
	const choices = /* @__PURE__ */ new Map();
	const add = (batch, order, kind) => {
		if (typeof batch !== "string" || !batch.trim()) return;
		const id = order?.id || null;
		const ref = JSON.stringify([id, batch]);
		if (!choices.has(ref)) choices.set(ref, {
			ref,
			batch,
			orderId: id,
			orderNumber: order?.number || "",
			kind
		});
	};
	for (const o of orders) for (const c of o.data.confirmations || []) if (c.kind === "main" && (c.code || o.data.code) === code) add(c.batch, o, "produced");
	for (const l of inv.lots || []) {
		if (l.code !== code || l.category !== "finished") continue;
		const o = orders.find((o) => o.id === l.orderId);
		if (l.orderId && !o || orderId && !o) continue;
		add(l.batch, o, "produced");
	}
	for (const o of orders) if (o.status === "open") add(nextOutputBatch(inv, o), o, "planned");
	for (const r of inv.state?.labelRuns || []) {
		if (r.code !== code) continue;
		const o = orders.find((o) => o.id === r.orderId);
		if (r.orderId && !o || orderId && !o) continue;
		add(r.batch, o, r.batchKind === "planned" ? "planned" : "recorded");
	}
	return [...choices.values()];
}
//#endregion
//#region lib/production-cycle.ts
var round$3 = (n) => Math.round(n * 1e3) / 1e3;
var text$1 = (v) => {
	if (typeof v !== "string" || !v.trim() || v.length > 160) throw Error("أدخل المرجع أو الملاحظات بشكل صحيح");
	return v.trim();
};
var quantity = (v) => {
	const n = Number(v);
	if (v == null || v === "" || !Number.isFinite(n) || n <= 0 || n > 1e9 || Math.abs(n * 1e3 - Math.round(n * 1e3)) > 1e-5) throw Error("أدخل كمية موجبة حتى 3 أرقام عشرية");
	return n;
};
var today = () => new Intl.DateTimeFormat("en-CA", {
	timeZone: "Africa/Cairo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
}).format(/* @__PURE__ */ new Date());
function productionState(d) {
	d.transfers ||= [];
	d.labelRuns ||= [];
	if (!d.warehouses.some((w) => w.code === "PROD")) d.warehouses.push({
		code: "PROD",
		name: "مخزن الإنتاج"
	});
	return d;
}
function demoStock(d, materials, demo) {
	productionState(d);
	if (!demo || d.demoStockVersion) return;
	for (const m of materials.filter((m) => [
		"raw",
		"packaging",
		"additive",
		"other"
	].includes(m.category) && !m.phantom && !masterData.retired.some((r) => r.code === m.code))) {
		const id = "DEMO39-" + m.code;
		if (d.entries.some((e) => e.id === id)) continue;
		const amount = m.category === "raw" ? m.code === "300010" ? 1e3 : 5e4 : m.unit === "M" ? 1e4 : m.code === "200003" ? 250 : m.code === "200004" ? 5e3 : 1e3;
		d.entries.push({
			id,
			code: m.code,
			name: m.name,
			category: m.category,
			unit: m.unit,
			warehouse: m.warehouse,
			batch: "DEMO-" + m.code,
			quantity: amount,
			quality: "A",
			kind: "opening",
			reason: "رصيد تجريبي للتصنيع",
			at: "2026-10-18T00:00:00Z",
			by: "DEMO"
		});
	}
	d.demoStockVersion = 1;
}
function transferLots(d, lots) {
	productionState(d);
	for (const t of d.transfers.filter((t) => t.receivedAt)) lots.push({
		...t.material,
		id: "TR-" + t.id,
		warehouse: t.toWarehouse,
		quantity: t.quantity,
		legacy: 0,
		source: t.number,
		kind: "transfer",
		at: t.receivedAt,
		by: t.receivedBy,
		reason: t.reason,
		quality: "A",
		requiresQuality: false,
		requiresWarehouseReceipt: false,
		originLotId: t.originLotId
	});
}
function transferAmounts(d, id) {
	return {
		out: d.transfers.filter((t) => t.sourceLotId === id && t.receivedAt).reduce((n, t) => round$3(n + t.quantity), 0),
		pending: d.transfers.filter((t) => t.sourceLotId === id && !t.receivedAt && !t.cancelledAt).reduce((n, t) => round$3(n + t.quantity), 0)
	};
}
function packedChoices(inv, bulkCode) {
	return inv.materials.filter((m) => m.category === "finished" && (!masterData.boms.some((b) => b.code === m.code) || masterData.boms.find((b) => b.code === m.code)?.lines.some((l) => l.code === bulkCode && l.quantity > 0)));
}
function bulkLots(inv, finishedCode) {
	return inv.lots.filter((l) => l.category === "semi" && l.orderId && l.quality === "A" && !l.warehousePending && l.available > 0 && l.color && l.grade && (!finishedCode || (l.allowedFinishedCodes ? l.allowedFinishedCodes.includes(finishedCode) : packedChoices(inv, l.code).some((m) => m.code === finishedCode))));
}
function assertProductionLot(order, l) {
	if ((order.data.cycleVersion || 0) < 3) return;
	if (l.warehouse !== "PROD") throw Error("حوّل المادة إلى مخزن الإنتاج وأكد استلام التحويل قبل الصرف");
	if (!order.data.requirements.some((r) => r.code === l.code)) throw Error("أضف المادة إلى احتياجات الأمر قبل الصرف");
	if (order.data.type === "Filling" && l.category === "semi" && (l.originLotId || l.id) !== order.data.sourceOriginLotId) throw Error("الباتش لا يطابق البلك المعتمد لأمر التعبئة");
}
function newInventoryAction(inv, u, b, now, id) {
	const d = productionState(inv.state), op = b.action;
	if (op === "inventory_transfer") {
		const l = inv.lots.find((l) => l.id === b.lotId), amount = quantity(b.quantity);
		if (l) {
			assertWarehouse(u, l.warehouse);
			assertScope(inv, u, { warehouse: l.warehouse });
			assertUsable(l, today());
		}
		const allocationOrderId = Number(b.allocationOrderId) || null;
		if (allocationOrderId) {
			const o = inv.orders.find((o) => o.id === allocationOrderId && o.status === "open");
			if (!o) throw Error("أمر الحجز غير متاح");
			assertScope(inv, u, { lineId: o.data.lineId });
		}
		const own = d.reservations.filter((r) => r.orderId === allocationOrderId && r.lotId === l?.id && r.remaining > 0);
		const ownQty = own.reduce((n, r) => n + r.remaining, 0);
		if (!l || l.quality !== "A" || l.warehousePending || amount > l.available + ownQty) throw Error("الرصيد المعتمد لا يكفي للتحويل");
		if (l.unit === "PC" && !Number.isInteger(amount)) throw Error("عدد القطع يجب أن يكون صحيحًا");
		if (!inv.warehouses.some((w) => w.code === b.toWarehouse) || l.warehouse === b.toWarehouse || l.warehouse !== "PROD" && b.toWarehouse !== "PROD") throw Error("اختر تحويلًا من أو إلى مخزن الإنتاج");
		const allocations = [];
		let left = amount;
		for (const r of own) {
			const n = Math.min(left, r.remaining);
			if (n > 0) {
				r.remaining = round$3(r.remaining - n);
				left = round$3(left - n);
				allocations.push({
					orderId: r.orderId,
					code: l.code,
					quantity: n,
					reservationId: r.id
				});
			}
		}
		const { id: unused, warehouse, quantity: q, balance, available, reserved, prepared, automaticShift, shiftId, shiftName, shiftSlot, day, calendarDay, shiftStart, shiftEnd, timeZone, ...material } = l;
		d.transfers.push({
			id,
			number: "TR-" + String(d.transfers.length + 1).padStart(7, "0"),
			allocations,
			sourceLotId: l.id,
			originLotId: l.originLotId || l.id,
			material,
			code: l.code,
			name: l.name,
			unit: l.unit,
			batch: l.batch,
			quantity: amount,
			fromWarehouse: l.warehouse,
			toWarehouse: b.toWarehouse,
			...shiftMetadata(now),
			reason: text$1(b.reason),
			at: now,
			by: u.email
		});
		return "تجهيز تحويل مخزن الإنتاج";
	}
	if (["inventory_transfer_accept", "inventory_transfer_cancel"].includes(op)) {
		const t = d.transfers.find((t) => t.id === b.transferId && !t.receivedAt && !t.cancelledAt);
		if (!t) throw Error("التحويل غير متاح أو تم اعتماده");
		if (op === "inventory_transfer_cancel") {
			for (const a of t.allocations || []) {
				const r = d.reservations.find((r) => r.id === a.reservationId);
				if (r) r.remaining = round$3(r.remaining + a.quantity);
			}
			t.cancelledAt = now;
			t.cancelledBy = u.email;
			t.cancelReason = text$1(b.reason);
			return "إلغاء تحويل مخزني";
		}
		if (u.role !== "admin" && (t.toWarehouse === "PROD" ? u.role !== "production" : u.role !== "warehouse")) throw Error("تأكيد التحويل من صلاحية مستلم المخزن");
		const l = inv.lots.find((l) => l.id === t.sourceLotId);
		if (!l || l.quality !== "A" || l.warehousePending || l.balance < t.quantity) throw Error("المادة لم تعد متاحة للتحويل");
		assertWarehouse(u, t.toWarehouse);
		assertScope(inv, u, { warehouse: t.toWarehouse });
		t.receivedAt = now;
		t.receivedBy = u.email;
		if (t.earlyPackingKey) {
			const target = inv.orders.find((o) => o.status === "open" && o.data.automaticFilling?.key === t.earlyPackingKey), job = d.automaticFillingJobs?.find((j) => j.key === t.earlyPackingKey);
			if (target && job && ![
				"completed",
				"cancelled",
				"rejected"
			].includes(job.status)) d.reservations.push({
				id: "RES-" + crypto.randomUUID(),
				orderId: target.id,
				lotId: "TR-" + t.id,
				code: t.code,
				quantity: t.quantity,
				remaining: t.quantity,
				at: now,
				by: u.email,
				earlyPackingKey: t.earlyPackingKey
			});
		}
		t.receivingShift = shiftMetadata(now);
		for (const a of t.allocations || []) d.reservations.push({
			id: "RES-" + crypto.randomUUID(),
			orderId: a.orderId,
			lotId: "TR-" + t.id,
			code: t.code,
			quantity: a.quantity,
			remaining: a.quantity,
			at: now,
			by: u.email,
			approval: true
		});
		return "اعتماد استلام تحويل مخزن الإنتاج";
	}
	if (op === "inventory_label_link") {
		const r = d.labelRuns.find((r) => r.id === b.runId && !r.outputLotId), o = inv.orders.find((o) => o.id === Number(b.orderId)), c = o?.data.confirmations.find((c) => c.id === b.confirmationId && c.kind === "main");
		if (!r || !c || o.data.type !== "Filling" || r.code !== c.code || r.batch !== c.batch || r.orderId && r.orderId !== o.id) throw Error("اختر دفعة معبأة تطابق كود وباتش الملصقات");
		assertScope(inv, u, { lineId: o.data.lineId });
		const count = (o.data.weights || []).filter((w) => w.confirmationId === c.id).reduce((n, w) => n + w.count, 0), used = d.labelRuns.filter((x) => x.outputLotId === "P-" + o.id + "-" + c.id).reduce((n, x) => n + x.count, 0);
		if (r.count + used > count) throw Error("عدد الملصقات أكبر من عدد العبوات المسجلة");
		Object.assign(r, {
			outputLotId: "P-" + o.id + "-" + c.id,
			orderId: o.id,
			orderNumber: o.number,
			linkedAt: now,
			linkedBy: u.email
		});
		return "ربط الملصقات بالعبوات المنتجة";
	}
	if (op === "inventory_labels") {
		const m = inv.materials.find((m) => m.code === b.code && m.category === "finished");
		if (!m) throw Error("اختر المنتج المعبأ");
		const count = Number(b.count);
		if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw Error("عدد الملصقات من 1 إلى 500");
		const date = (v) => {
			if (!v) return "";
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw Error("تاريخ الملصق غير صحيح");
			return v;
		};
		const productionDate = date(b.productionDate), expiryDate = date(b.expiryDate);
		if (productionDate && expiryDate && expiryDate < productionDate) throw Error("الصلاحية تسبق الإنتاج");
		if (b.orderId && !inv.orders.some((o) => o.id === Number(b.orderId) && o.data.type === "Filling" && o.data.code === m.code)) throw Error("أمر التعبئة لا يطابق المنتج");
		const matches = labelBatchChoices(inv, m.code, b.orderId).filter((c) => b.batchRef ? c.ref === b.batchRef : c.batch === b.batch);
		if (matches.length !== 1) throw Error("اختر رقم الباتش من الباتشات المسجلة للصنف");
		const selected = matches[0], o = inv.orders.find((o) => o.id === selected.orderId);
		if (o) assertScope(inv, u, { lineId: o.data.lineId });
		const start = d.labelRuns.reduce((n, r) => Math.max(n, r.end), 0) + 1;
		d.labelRuns.push({
			id,
			number: "LP-" + String(d.labelRuns.length + 1).padStart(7, "0"),
			code: m.code,
			name: m.name,
			batch: selected.batch,
			batchRef: selected.ref,
			batchKind: selected.kind,
			count,
			start,
			end: start + count - 1,
			serialPrefix: b.demo === true ? "LB-D-" : "LB-L-",
			orderId: selected.orderId,
			orderNumber: selected.orderNumber,
			nominalWeight: b.nominalWeight == null || b.nominalWeight === "" ? null : quantity(b.nominalWeight),
			productionDate,
			expiryDate,
			notes: String(b.notes || "").slice(0, 160),
			at: now,
			by: u.email
		});
		return "حجز أرقام ملصقات مستقلة";
	}
	return null;
}
//#endregion
//#region lib/cycle-state.ts
var round$2 = (v) => Math.round(v * 1e3) / 1e3;
function normalizeCycle(d) {
	for (const key of [
		"warehouseReceipts",
		"consumptions",
		"packs",
		"customers",
		"deliveries",
		"containerReturns",
		"settlements",
		"returnRequests",
		"supplyRequests",
		"incomingInspections"
	]) d[key] ||= [];
	return d;
}
function wipRows(inv, orderId) {
	const d = normalizeCycle(inv.state), waste = /* @__PURE__ */ new Map();
	for (const o of inv.orders || []) for (const w of o.data.waste || []) {
		const key = o.id + "|" + w.code;
		waste.set(key, (waste.get(key) || 0) + w.quantity);
	}
	return d.issues.filter((i) => i.acceptedAt && (!orderId || i.orderId === orderId)).map((i) => {
		const returned = d.returns.filter((r) => r.issueId === i.id).reduce((s, r) => s + r.quantity, 0);
		const used = d.consumptions.filter((c) => c.issueId === i.id && !c.reversedAt).reduce((s, c) => s + c.quantity, 0);
		const packed = d.packs.filter((p) => p.issueId === i.id && !p.reversedAt).reduce((s, p) => s + p.quantity, 0);
		const key = i.orderId + "|" + i.code, loss = Math.min(Math.max(0, i.quantity - returned - used - packed), waste.get(key) || 0);
		waste.set(key, (waste.get(key) || 0) - loss);
		const pendingReturn = d.returnRequests.filter((r) => r.issueId === i.id && !r.acceptedAt && !r.cancelledAt).reduce((s, r) => s + r.quantity, 0);
		const remaining = round$2(i.quantity - returned - used - packed - loss);
		return {
			...i,
			category: i.category || inv.materials?.find((m) => m.code === i.code)?.category,
			returned,
			used: round$2(used + packed),
			waste: round$2(loss),
			remaining,
			pendingReturn,
			free: round$2(remaining - pendingReturn)
		};
	});
}
function custodyRows(inv) {
	const d = normalizeCycle(inv.state);
	return d.deliveries.flatMap((doc) => doc.packages.filter((p) => p.returnable).map((p) => {
		const returned = d.containerReturns.filter((r) => r.deliveryId === doc.id && r.packId === p.packId).reduce((s, r) => s + r.quantity, 0);
		const settled = d.settlements.filter((r) => r.deliveryId === doc.id && r.packId === p.packId).reduce((s, r) => s + r.quantity, 0);
		return {
			deliveryId: doc.id,
			number: doc.number,
			customerId: doc.customerId,
			customer: doc.customer,
			packId: p.packId,
			code: p.code,
			name: p.name,
			unit: p.unit,
			outgoing: p.quantity,
			returned,
			settled,
			remaining: round$2(p.quantity - returned - settled),
			due: doc.due,
			at: doc.at
		};
	}));
}
function cycleLots(state, lots) {
	const d = normalizeCycle(state);
	for (const l of lots) {
		const receipt = d.warehouseReceipts.find((r) => r.lotId === l.id);
		l.expectedQuantity = l.quantity;
		l.warehousePending = Boolean(l.requiresWarehouseReceipt && !receipt);
		if (l.warehousePending) l.quantity = 0;
		if (receipt) {
			l.receiptNumber = receipt.number;
			l.at = receipt.at;
			l.by = receipt.by;
			l.warehouse = receipt.warehouse;
		}
		const inspection = d.incomingInspections.find((q) => q.lotId === l.id);
		if (l.requiresQuality) l.quality = inspection?.decision || "H";
		l.delivered = round$2(d.deliveries.filter((x) => x.lotId === l.id).reduce((s, x) => s + x.quantity, 0));
	}
}
//#endregion
//#region lib/order-lifecycle.ts
var lifecycleActions = [
	"production_period_request",
	"production_period_decide",
	"production_reopen_shift",
	"production_handover_record",
	"production_cancel"
];
var date = (v) => {
	if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw Error("تاريخ غير صحيح");
	return v;
};
async function orderLifecycle(db, u, b) {
	const op = b.action, role = actualRole(u);
	if (!(op === "production_period_request" ? [
		"admin",
		"plant_manager",
		"production",
		"planner"
	] : op === "production_handover_record" ? ["admin", "production"] : ["admin", "plant_manager"]).includes(role)) throw Error("لا توجد صلاحية لهذا الإجراء");
	if (!Number.isSafeInteger(b.orderId) || !Number.isSafeInteger(b.version)) throw Error("رقم أمر غير صالح");
	const demo = b.demo === true ? 1 : 0, inv = await inventorySnapshot(db, demo), o = inv.orders.find((x) => x.id === b.orderId);
	if (!o || o.status !== "open" || o.version !== b.version) throw Error("الأمر مغلق أو تغير؛ حدّث الصفحة");
	const d = o.data, now = (/* @__PURE__ */ new Date()).toISOString(), clock = operatingShift(now), reason = required(b.reason, "سبب الإجراء");
	assertScope(inv, u, { lineId: d.lineId });
	assertDayOpen(inv, clock.day);
	d.periodRequests ||= [];
	d.history ||= [];
	d.handovers ||= [];
	let status = "open", changedInventory = false, action = "";
	if (op === "production_period_request") {
		const from = date(b.from), to = date(b.to);
		if (from > to || from === d.from && to === d.to) throw Error("راجع الفترة الجديدة");
		if (d.periodRequests.some((r) => r.status === "pending")) throw Error("يوجد طلب فترة معلق");
		d.periodRequests.push({
			id: crypto.randomUUID(),
			from,
			to,
			previousFrom: d.from,
			previousTo: d.to,
			status: "pending",
			reason,
			by: u.email,
			at: now
		});
		action = "طلب تعديل فترة الأمر";
	}
	if (op === "production_period_decide") {
		const r = d.periodRequests.find((r) => r.id === b.requestId && r.status === "pending");
		if (!r || !["A", "R"].includes(b.decision)) throw Error("طلب الفترة غير متاح");
		assertApprover(u, r.by, demo);
		if (b.decision === "A") {
			if (r.previousFrom !== d.from || r.previousTo !== d.to) throw Error("تغيرت الفترة؛ قدم طلبًا جديدًا");
			if ([
				...d.confirmations || [],
				...d.receipts || [],
				...d.waste || [],
				...d.weights || [],
				...[
					"issues",
					"consumptions",
					"packs"
				].flatMap((k) => inv.state[k].filter((x) => x.orderId === o.id))
			].some((x) => {
				const day = x.day || (x.at ? operatingShift(x.at).day : null);
				return day && (day < r.from || day > r.to);
			})) throw Error("الفترة الجديدة تستبعد حركات تنفيذ مسجلة");
			if (d.type !== "Filling" && inv.orders.some((x) => x.id !== o.id && !x.data.cancelledAt && x.data.type !== "Filling" && x.data.code === d.code && x.data.from <= r.to && x.data.to >= r.from)) throw Error("تداخل مع أمر بلك لنفس المنتج");
			d.periodHistory ||= [];
			d.periodHistory.push({
				from: d.from,
				to: d.to,
				newFrom: r.from,
				newTo: r.to,
				at: now,
				by: u.email,
				reason
			});
			d.from = r.from;
			d.to = r.to;
		}
		Object.assign(r, {
			status: b.decision === "A" ? "approved" : "rejected",
			decision: b.decision,
			decidedAt: now,
			decidedBy: u.email,
			decisionReason: reason
		});
		action = "قرار تعديل فترة الأمر";
	}
	if (op === "production_reopen_shift") {
		const s = d.shifts.find((s) => s.id === b.shiftId);
		if (!s?.closedAt || !s.automatic || s.id !== clock.id) throw Error("يمكن إعادة فتح الشيفت الحالي فقط");
		if (clock.day < d.from || clock.day > d.to) throw Error("اعتمد تعديل فترة الأمر أولًا");
		s.reopenHistory ||= [];
		s.reopenHistory.push({
			closedAt: s.closedAt,
			closedBy: s.closedBy,
			at: now,
			by: u.email,
			reason
		});
		Object.assign(s, {
			closedAt: null,
			closedBy: null,
			autoEnded: false
		});
		for (const h of d.handovers.filter((h) => h.shiftId === s.id && !h.supersededAt)) Object.assign(h, {
			supersededAt: now,
			supersededBy: u.email,
			supersededReason: reason
		});
		inv.state.operationShifts = (inv.state.operationShifts || []).filter((x) => x.orderId !== o.id || x.id !== s.id);
		inv.state.operationShifts.push({
			...s,
			orderId: o.id
		});
		changedInventory = true;
		action = "إعادة فتح الشيفت الحالي";
	}
	if (op === "production_handover_record") {
		const s = d.shifts.find((s) => s.id === b.shiftId);
		if (!s?.closedAt) throw Error("اختر شيفتًا منتهيًا");
		assertDayOpen(inv, s.day);
		if (d.handovers.some((h) => h.shiftId === s.id && !h.supersededAt)) throw Error("يوجد تسليم مسجل لهذا الشيفت");
		const resources = {};
		for (const key of [
			"laborHours",
			"machineHours",
			"electricity",
			"steam",
			"water"
		]) {
			const v = b[key];
			resources[key] = v == null || v === "" ? null : Number(v);
			if (resources[key] !== null && (!Number.isFinite(resources[key]) || resources[key] < 0 || resources[key] > 1e9)) throw Error("قيمة مورد غير صحيحة");
		}
		d.handovers.push({
			id: "HO-" + crypto.randomUUID(),
			shiftId: s.id,
			day: s.day,
			notes: reason,
			resources,
			remaining: [],
			lateEntry: true,
			at: now,
			by: u.email
		});
		action = "تسجيل تسليم شيفت منتهي";
	}
	if (op === "production_cancel") {
		if (d.automaticFilling) throw Error("استخدم إلغاء مسودة التعبئة التلقائية");
		if ([
			"confirmations",
			"receipts",
			"waste",
			"weights",
			"packaging"
		].some((k) => d[k]?.length) || [
			"issues",
			"consumptions",
			"packs"
		].some((k) => inv.state[k].some((x) => x.orderId === o.id))) throw Error("لا يمكن إلغاء أمر بدأت عليه حركات تنفيذ");
		if (inv.orders.some((x) => x.data.sourceOrderId === o.id && !x.data.cancelledAt)) throw Error("ألغِ أوامر التعبئة التابعة أولًا");
		if ((inv.state.transfers || []).some((t) => !t.receivedAt && !t.cancelledAt && (t.allocations || []).some((a) => a.orderId === o.id))) throw Error("ألغِ التحويلات المعلقة المرتبطة بالأمر أولًا");
		for (const r of inv.state.reservations.filter((x) => x.orderId === o.id && x.remaining > 0)) {
			const l = inv.lots.find((l) => l.id === r.lotId);
			if (l) assertScope(inv, u, { warehouse: l.warehouse });
			Object.assign(r, {
				remaining: 0,
				releasedAt: now,
				releasedBy: u.email
			});
		}
		for (const p of inv.state.preparations.filter((x) => x.orderId === o.id && x.quantity > x.received + x.cancelled)) {
			assertScope(inv, u, { warehouse: p.warehouse });
			Object.assign(p, {
				cancelled: p.quantity - p.received,
				cancelledAt: now,
				cancelledBy: u.email,
				reason
			});
		}
		for (const r of inv.state.supplyRequests.filter((x) => x.orderId === o.id && !x.cancelledAt)) Object.assign(r, {
			cancelledAt: now,
			cancelledBy: u.email,
			reason
		});
		for (const r of controls(inv.state).requests.filter((x) => x.orderId === o.id && x.status === "pending")) Object.assign(r, {
			status: "cancelled",
			cancelledAt: now,
			cancelledBy: u.email,
			reason
		});
		Object.assign(d, {
			cancelledAt: now,
			cancelledBy: u.email,
			cancelReason: reason
		});
		status = "closed";
		changedInventory = true;
		action = "إلغاء أمر غير مستخدم";
	}
	d.history.push({
		at: now,
		by: u.email,
		action,
		reason
	});
	const token = crypto.randomUUID();
	d.lifecycleToken = token;
	let sql = "UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND demo=? AND status='open' AND version=? AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=?";
	const args = [
		JSON.stringify(d),
		status,
		o.id,
		demo,
		o.version,
		demo,
		inv.version
	];
	if (op === "production_period_decide" && b.decision === "A" && d.type !== "Filling") {
		sql += " AND NOT EXISTS (SELECT 1 FROM production_orders other WHERE other.id<>? AND other.demo=? AND json_extract(other.data,'$.cancelledAt') IS NULL AND json_extract(other.data,'$.type') IN ('Bulk','PI01') AND json_extract(other.data,'$.code')=? AND json_extract(other.data,'$.from')<=? AND json_extract(other.data,'$.to')>=?)";
		args.push(o.id, demo, d.code, d.to, d.from);
	}
	if (changedInventory) {
		if (!db.batch) throw Error("الإجراء يحتاج خادمًا يدعم الحفظ الذري");
		inv.state.history.push({
			at: now,
			by: u.email,
			action,
			reason,
			orderId: o.id
		});
		const guard = " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=? AND json_extract(data,'$.lifecycleToken')=?)", g = [
			o.id,
			demo,
			o.version + 1,
			token
		];
		const invSql = inv.version === 0 ? "INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1" + guard : "UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?" + guard;
		const invArgs = inv.version === 0 ? [
			demo,
			JSON.stringify(inv.state),
			...g
		] : [
			JSON.stringify(inv.state),
			demo,
			inv.version,
			...g
		];
		const saved = await db.batch([{
			sql,
			args
		}, {
			sql: invSql,
			args: invArgs
		}]);
		if (saved.length !== 2 || saved.some((x) => x.changes !== 1)) throw Error("تغير الأمر أو المخزون؛ حدّث الصفحة");
	} else if (!(await db.run(sql, args)).changes) throw Error("تغير الأمر أو المخزون؛ حدّث الصفحة");
	return {
		ok: true,
		orderId: o.id
	};
}
//#endregion
//#region lib/packing-plan.ts
function packingPlan(code, target, materials, policy = "partial", dataset = masterData) {
	const plan = bomPlan(code, target, materials, dataset);
	if (!plan) return null;
	const recipe = dataset.boms.find((b) => b.code === code);
	const drum = plan.inputs.find((r) => ["200000", "200010"].includes(r.code));
	const legacyCount = dataset.revision === masterData.revision && drum ? recipe.lines.filter((l) => l.code === drum.code && l.quantity > 0).reduce((n, l) => n + l.quantity, 0) : 0;
	const nominal = recipe.nominalWeight || (legacyCount ? recipe.base / legacyCount : 0);
	if (!nominal) return plan;
	if (!["full", "partial"].includes(policy)) throw Error("اختر سياسة العبوات");
	const count = Math.ceil(target / nominal - 1e-9), whole = Math.floor(target / nominal + 1e-9), partial = Math.round((target - whole * nominal) * 1e3) / 1e3;
	if (policy === "full" && partial > 0) throw Error("العبوات الكاملة تتطلب كمية من مضاعفات الوزن الاسمي");
	const rounded = bomPlan(code, count * nominal, materials, dataset);
	for (const r of plan.inputs) {
		r.theoreticalQuantity = r.quantity;
		if (materials.find((m) => m.code === r.code)?.category === "packaging") {
			const n = rounded.inputs.find((x) => x.code === r.code).quantity;
			r.quantity = r.unit === "PC" ? Math.ceil(n - 1e-9) : Math.round(n * 1e3) / 1e3;
			r.bomQuantity = r.quantity;
		}
	}
	return {
		...plan,
		packing: {
			policy,
			nominalWeight: nominal,
			count,
			whole,
			partial
		}
	};
}
//#endregion
//#region lib/auto-filling-plan.ts
function automaticFillingCandidates(materials, bulkCode) {
	return materials.filter((m) => m.category === "finished" && !masterData.conflicts.some((x) => x.code === m.code) && !masterData.retired.some((x) => x.code === m.code)).filter((m) => {
		const recipe = masterData.boms.find((r) => r.code === m.code);
		if (!recipe || recipe.unit !== m.unit) return false;
		const semi = recipe.lines.filter((l) => l.quantity > 0 && !l.coproduct && materials.find((m) => m.code === l.code)?.category === "semi");
		return semi.length > 0 && semi.every((l) => l.code === bulkCode) && semi.some((l) => l.code === bulkCode);
	});
}
function automaticFillingPlan(materials, bulkCode, sourceQuantity, finishedCode, policy = "partial") {
	const finished = automaticFillingCandidates(materials, bulkCode).find((m) => m.code === finishedCode), source = materials.find((m) => m.code === bulkCode), recipe = masterData.boms.find((r) => r.code === finishedCode);
	if (!finished || !source || !recipe) throw Error("اختر منتجًا معبأ له مخطط صرف مرتبط بكود البلك");
	if (!["partial", "full"].includes(policy) || !Number.isFinite(sourceQuantity) || sourceQuantity <= 0) throw Error("راجع كمية وسياسة التعبئة التلقائية");
	const amount = recipe.lines.filter((l) => l.code === bulkCode && l.quantity > 0 && !l.coproduct).reduce((n, l) => {
		if (l.unit === source.unit) return n + l.quantity;
		if (l.unit === "G" && source.unit === "KG") return n + l.quantity / 1e3;
		throw Error("وحدة البلك لا تطابق مخطط التعبئة");
	}, 0);
	const rawTarget = sourceQuantity * recipe.base / amount;
	let target = finished.unit === "PC" ? Math.floor(rawTarget + 1e-8) : Math.floor(rawTarget * 1e3 + 1e-7) / 1e3;
	if (policy === "full") {
		const partial = packingPlan(finishedCode, target, materials, "partial");
		if (partial?.packing) {
			target = Math.floor(target / partial.packing.nominalWeight + 1e-9) * partial.packing.nominalWeight;
			target = Math.round(target * 1e3) / 1e3;
			if (target <= 0) throw Error("كمية البلك لا تكفي لعبوة كاملة؛ اختر السماح بعبوة جزئية");
		}
	}
	const plan = packingPlan(finishedCode, target, materials, policy);
	if (!plan || plan.inputs.some((r) => r.quantity <= 0)) throw Error("مخطط صرف التعبئة غير متاح");
	if (plan.inputs.some((r) => masterData.conflicts.some((m) => m.code === r.code) || masterData.retired.some((m) => m.code === r.code) || materials.find((m) => m.code === r.code)?.phantom)) throw Error("مخطط التعبئة يحتوي صنفًا معلقًا أو افتراضيًا؛ راجع البيانات الأساسية");
	return {
		finished,
		target,
		plan,
		bulkRequired: plan.inputs.find((r) => r.code === bulkCode).quantity
	};
}
//#endregion
//#region lib/early-packing.ts
function earlyPackingPlan(materials, code, target, finishedCode, policy) {
	const p = automaticFillingPlan(materials, code, target, finishedCode, policy);
	return {
		code: finishedCode,
		name: p.finished.name,
		policy,
		target: p.target,
		unit: p.finished.unit,
		inputs: p.plan.inputs.filter((r) => materials.some((m) => m.code === r.code && m.category === "packaging"))
	};
}
/** Create the bulk, its numbered filling draft and stock holds in one guarded batch. */
async function createEarlyPacking(db, inv, data, bulkSql, bulkArgs, demo, actor, now) {
	if (!db.batch) throw Error("التجهيز المبكر يحتاج خادم يدعم المعاملات");
	const p = data.earlyPacking, key = "PK-" + crypto.randomUUID();
	data.earlyPacking.key = key;
	bulkArgs[1] = JSON.stringify(data);
	const bulk = bulkSql + " AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=?";
	const parent = "SELECT id FROM production_orders WHERE demo=? AND json_extract(data,'$.earlyPacking.key')=?";
	const child = "SELECT id FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=?";
	const draft = {
		...data,
		earlyPacking: null,
		type: "Filling",
		processType: "PI02",
		code: p.code,
		name: p.name,
		target: p.target,
		unit: p.unit,
		warehouse: "FG",
		bom: null,
		requirements: [],
		automaticFilling: {
			key,
			planned: true
		},
		notes: "تجهيز مبكر — في انتظار ناتج البلك"
	};
	const insert = "INSERT INTO production_orders(demo,version,status,data) SELECT ?,1,'open',json_set(?,'$.sourceOrderId',(" + parent + "),'$.serial',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1,'$.number','FO-' || printf('%07d',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1)) FROM production_orders WHERE json_extract(data,'$.type')='Filling' HAVING EXISTS (SELECT id FROM production_orders WHERE demo=? AND json_extract(data,'$.earlyPacking.key')=?)";
	const state = inv.state;
	const available = /* @__PURE__ */ new Map();
	const lots = inv.lots.filter((l) => ["PROD", "PACK"].includes(l.warehouse) && l.quality === "A" && !l.warehousePending && !l.expired && l.available > 0).sort((a, b) => Number(b.warehouse === "PROD") - Number(a.warehouse === "PROD") || String(a.expiryDate || "9999").localeCompare(String(b.expiryDate || "9999")) || String(a.at).localeCompare(String(b.at)));
	for (const l of lots) try {
		assertScope(inv, actor, { warehouse: l.warehouse });
		available.set(l.id, l.available);
	} catch {
		available.set(l.id, 0);
	}
	for (const need of p.shift?.inputs || p.inputs) {
		let left = need.quantity;
		for (const l of lots.filter((l) => l.code === need.code && l.unit === need.unit)) {
			let quantity = Math.min(left, available.get(l.id) || 0);
			if (l.unit === "PC") quantity = Math.floor(quantity);
			if (quantity <= 0) continue;
			if (l.warehouse === "PACK") {
				const { id: sourceLotId, quantity: originalQuantity, warehouse, ...material } = l;
				state.transfers.push({
					id: crypto.randomUUID(),
					number: "TR-" + String(state.transfers.length + 1).padStart(7, "0"),
					sourceLotId,
					originLotId: l.originLotId || l.id,
					material,
					code: l.code,
					name: l.name,
					unit: l.unit,
					batch: l.batch,
					quantity,
					fromWarehouse: "PACK",
					toWarehouse: "PROD",
					reason: "تغطية عجز تجهيز التعبئة",
					earlyPackingKey: key,
					at: now,
					by: actor.email,
					...shiftMetadata(now)
				});
			} else state.reservations.push({
				id: crypto.randomUUID(),
				orderId: null,
				earlyPackingKey: key,
				lotId: l.id,
				code: l.code,
				quantity,
				remaining: quantity,
				at: now,
				by: actor.email
			});
			available.set(l.id, (available.get(l.id) || 0) - quantity);
			left = Math.round((left - quantity) * 1e3) / 1e3;
			if (!left) break;
		}
	}
	const list = state.automaticFillingJobs ||= [];
	list.push({
		key,
		planned: true,
		parentOrderId: null,
		finishedCode: p.code,
		status: "waiting_quality",
		shortages: [],
		at: now,
		by: actor.email
	});
	const save = "INSERT INTO inventory(id,version,data) SELECT ?,1,json_set(?, '$.reservations',json((SELECT json_group_array(json(CASE WHEN json_extract(r.value,'$.earlyPackingKey')=? THEN json_set(r.value,'$.orderId',(" + child + ")) ELSE r.value END)) FROM json_each(?, '$.reservations') r)), '$.automaticFillingJobs[" + (list.length - 1) + "].parentOrderId',(SELECT id FROM production_orders WHERE demo=? AND json_extract(data,'$.earlyPacking.key')=?)) WHERE EXISTS (SELECT id FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=inventory.version+1 WHERE inventory.version=?";
	const snapshot = JSON.stringify(state);
	const rows = await db.batch([
		{
			sql: bulk,
			args: [
				...bulkArgs,
				demo,
				inv.version
			]
		},
		{
			sql: insert,
			args: [
				demo,
				JSON.stringify(draft),
				demo,
				key,
				demo,
				key
			]
		},
		{
			sql: save,
			args: [
				demo,
				snapshot,
				key,
				demo,
				key,
				snapshot,
				demo,
				key,
				demo,
				key,
				inv.version
			]
		}
	]);
	if (rows.some((r) => r.changes !== 1)) throw Error("تغير الرصيد أو يوجد أمر بلك لنفس الفترة؛ حدّث البيانات وأعد المحاولة");
	return {
		ok: true,
		orderId: rows[0].id
	};
}
//#endregion
//#region lib/quality-disposition.ts
function qualityDisposition(b, warnings = []) {
	const reasons = [...new Set(warnings)];
	if (b.conformity === "FAIL" && !reasons.length) reasons.push("نتيجة الفحص غير مطابقة للمواصفة");
	if (b.conformity && !["PASS", "FAIL"].includes(b.conformity)) throw Error("اختر نتيجة المطابقة");
	const override = b.decision === "A" && reasons.length > 0, reason = String(b.reason || "").trim();
	if (reason.length > 160) throw Error("سبب قرار الجودة طويل");
	if (override && b.acceptNonconformance !== true) throw Error("أكد مراجعة تحذيرات عدم المطابقة قبل قبول الجودة");
	if ((override || b.decision === "R") && !reason) throw Error("اكتب سبب قرار الجودة");
	return {
		conformity: b.conformity || (reasons.length ? "FAIL" : "NOT_RECORDED"),
		warnings: reasons,
		override,
		warningAcknowledged: override && b.acceptNonconformance === true,
		reason
	};
}
//#endregion
//#region lib/production.ts
var day$1 = (v) => {
	const s = required(v, "التاريخ");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw Error("تاريخ غير صحيح");
	return s;
};
var productionNumber = (id) => "PI01-" + String(id).padStart(7, "0");
var productionBatch = (id) => "PB-" + String(id).padStart(7, "0");
var decodeOrder = (r) => {
	const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
	return {
		...r,
		number: data.number || productionNumber(r.id),
		batch: productionBatch(r.id),
		data
	};
};
async function productionOperation(db, u, b) {
	if (lifecycleActions.includes(b.action)) return orderLifecycle(db, u, b);
	u = operator(u, b.action);
	const now = (/* @__PURE__ */ new Date()).toISOString(), fastOutput = b.action === "production_confirm_usage", op = fastOutput ? "production_confirm" : b.action, permissions = {
		production_rate: ["production"],
		production_balance: ["production"],
		production_balance_decide: ["admin"],
		production_handover_accept: ["production"],
		production_change_decide: ["admin"],
		production_weigh: ["production"],
		production_create: ["production"],
		production_bom: ["production"],
		production_requirement: ["production"],
		production_shift: ["production"],
		production_close_shift: ["production"],
		production_confirm: ["production"],
		production_waste: ["production"],
		production_quality: ["quality"],
		production_close: ["production"]
	};
	if (!permissions[op] || u.role !== "admin" && !permissions[op].includes(u.role)) throw Error("لا توجد صلاحية لهذا الإجراء؛ صرف المواد أصبح من حركات المخازن");
	if (op === "production_create") {
		const from = day$1(b.from), type = b.type || "Bulk", to = type === "Filling" ? from : new Date(Date.parse(from) + 6 * 864e5).toISOString().slice(0, 10);
		if (!["Bulk", "Filling"].includes(type)) throw Error("اختر نوع الأمر");
		const inv = await inventorySnapshot(db, b.demo === true ? 1 : 0), m = inv.materials.find((m) => m.code === b.code);
		if (!m || m.category !== (type === "Bulk" ? "semi" : "finished")) throw Error("أضف المنتج في دليل المواد ثم اختر نصف مصنع للـBulk أو منتج تام للـFilling");
		if (!inv.warehouses.some((w) => w.code === b.warehouse)) throw Error("اختر مخزن الناتج");
		const plan = packingPlan(m.code, qty(b.target), inv.materials, b.packingPolicy || "partial");
		const control = controls(inv.state), lineId = b.lineId || (b.demo === true ? control.machines.find((m) => m.kind === "line")?.id : null);
		if (!control.machines.some((m) => m.id === lineId && m.kind === "line")) throw Error("حدد خط الإنتاج من شاشة الصيانة والمعدات");
		let source = null;
		if (type === "Filling") {
			source = bulkLots(inv, m.code).find((l) => l.id === b.sourceLotId);
			if (!source) throw Error("اختر باتش بلك معتمد اللون والجودة لهذا المنتج");
			if (qty(b.target) > source.available) throw Error("مستهدف التعبئة أكبر من المتاح في باتش البلك");
		}
		assertScope(inv, u, { lineId });
		const data = {
			cycleVersion: 4,
			lineDailyRate: b.lineDailyRate == null || b.lineDailyRate === "" ? 127 : qty(b.lineDailyRate),
			lineId,
			costCentre: control.machines.find((m) => m.id === lineId)?.costCentre || "",
			packingPolicy: b.packingPolicy || "partial",
			processType: type === "Bulk" ? "PI01" : "PI02",
			sourceLotId: source?.id || null,
			sourceOriginLotId: source ? source.originLotId || source.id : null,
			sourceOrderId: source?.orderId || null,
			sourceBatch: source?.batch || "",
			sourceColor: source?.color || "",
			sourceGrade: source?.grade || "",
			notes: String(b.notes || "").slice(0, 160),
			bom: plan,
			type,
			code: m.code,
			name: m.name,
			unit: m.unit,
			warehouse: b.warehouse,
			target: qty(b.target),
			from,
			to,
			createdAt: now,
			createdBy: u.email,
			creationShift: shiftMetadata(now),
			requirements: plan?.inputs || (source ? [{
				code: source.code,
				name: source.name,
				unit: source.unit,
				quantity: qty(b.target),
				source: "البلك المختار"
			}] : []),
			receipts: [],
			shifts: [],
			packaging: [],
			confirmations: [],
			waste: [],
			history: [{
				at: now,
				by: u.email,
				action: "إنشاء أمر " + type
			}]
		};
		if (type === "Bulk" && b.fillingCode) {
			const policy = b.fillingPolicy || "partial", code = String(b.fillingCode);
			Object.assign(data, {
				earlyPacking: earlyPackingPlan(inv.materials, m.code, data.target, code, policy),
				automaticFillingDefaults: {
					code,
					policy
				}
			});
			if (b.shiftPackingQty !== void 0 && b.shiftPackingQty !== "") {
				const amount = qty(b.shiftPackingQty), slot = Number(b.shiftPackingSlot || 1);
				if (amount > data.target || ![
					1,
					2,
					3
				].includes(slot)) throw Error("راجع كمية التجهيز ورقم الشيفت؛ الكمية لا تتجاوز أمر البلك");
				const shiftPlan = earlyPackingPlan(inv.materials, m.code, amount, code, policy);
				Object.assign(data.earlyPacking, { shift: {
					day: from,
					slot,
					amount,
					inputs: shiftPlan.inputs
				} });
			}
		}
		let insertSql = `INSERT INTO production_orders(demo,version,status,data) SELECT ?,1,'open',json_set(?, '$.serial',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1,'$.number',? || printf('%07d',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1)) FROM production_orders WHERE json_extract(data,'$.type')=? HAVING ?='Filling' OR NOT EXISTS (SELECT 1 FROM production_orders prior WHERE prior.demo=? AND json_extract(prior.data,'$.cancelledAt') IS NULL AND json_extract(prior.data,'$.type') IN ('Bulk','PI01') AND json_extract(prior.data,'$.code')=? AND json_extract(prior.data,'$.from')<=? AND json_extract(prior.data,'$.to')>=?)`;
		const insertArgs = [
			b.demo === true ? 1 : 0,
			JSON.stringify(data),
			type === "Bulk" ? "BPO-" : "FO-",
			type,
			type,
			b.demo === true ? 1 : 0,
			m.code,
			to,
			from
		];
		if (type === "Bulk" && b.fillingCode) return createEarlyPacking(db, inv, data, insertSql, insertArgs, b.demo === true ? 1 : 0, u, now);
		if (b.assistantInventoryVersion !== void 0) {
			if (type !== "Filling" || !source || b.assistantInventoryVersion !== inv.version || !Number.isSafeInteger(b.assistantOrderVersion)) throw Error("تغيرت بيانات المعاينة؛ راجع الأمر مرة أخرى");
			const sourceOrder = inv.orders.find((o) => o.id === source.orderId && o.status === "open" && o.version === b.assistantOrderVersion);
			if (!sourceOrder) throw Error("تغير أمر البلك أو أُغلق؛ راجع المعاينة");
			insertSql = insertSql.replace("HAVING ?='Filling' OR NOT EXISTS", "HAVING (?='Filling' OR NOT EXISTS") + ") AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=? AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=? AND status='open') AND NOT EXISTS (SELECT 1 FROM production_orders WHERE demo=? AND status='open' AND json_extract(data,'$.type')='Filling' AND json_extract(data,'$.sourceOrderId')=? AND (json_extract(data,'$.sourceLotId')=? OR json_extract(data,'$.automaticFilling.planned')=1))";
			const scope = b.demo === true ? 1 : 0;
			insertArgs.push(scope, inv.version, sourceOrder.id, scope, sourceOrder.version, scope, sourceOrder.id, source.id);
		}
		const result = await db.run(insertSql, insertArgs);
		if (!result.changes) {
			const conflict = await db.first("SELECT * FROM production_orders WHERE demo=? AND json_extract(data,'$.cancelledAt') IS NULL AND json_extract(data,'$.type') IN ('Bulk','PI01') AND json_extract(data,'$.code')=? AND json_extract(data,'$.from')<=? AND json_extract(data,'$.to')>=? ORDER BY id LIMIT 1", [
				b.demo === true ? 1 : 0,
				m.code,
				to,
				from
			]);
			const c = conflict ? decodeOrder(conflict) : null;
			throw Error(c ? "يوجد أمر Bulk لهذا المنتج: " + c.number + " — من " + c.data.from + " إلى " + c.data.to + "؛ افتح الأمر الموجود." : "تعارض إنشاء الأمر؛ حدّث الصفحة");
		}
		return {
			ok: true,
			orderId: result.id
		};
	}
	if (!Number.isSafeInteger(b.orderId) || !Number.isSafeInteger(b.version)) throw Error("رقم أمر غير صالح");
	const raw = await db.first("SELECT * FROM production_orders WHERE id=?", [b.orderId]);
	if (!raw) throw Error("الأمر غير موجود");
	const inv = await inventorySnapshot(db, raw.demo);
	if (fastOutput) {
		if (raw.demo !== (b.demo === true ? 1 : 0)) throw Error("الأمر خارج سجل التشغيل الحالي");
		const previous = completedFast(inv, b, u);
		if (previous) return previous;
		if (!Number.isSafeInteger(b.inventoryVersion) || b.inventoryVersion !== inv.version) throw Error("تغيرت المواد المستلمة؛ أعد مراجعة الاستهلاك");
	}
	if (raw.version !== b.version || raw.status !== "open") throw Error("الأمر مغلق أو تغير؛ حدّث الصفحة");
	const order = mergeOrderShifts(inv.state, decodeOrder(raw), now), d = order.data;
	let action = "", status = "open";
	assertScope(inv, u, { lineId: d.lineId });
	assertDayOpen(inv, operatingShift(now).day);
	if (![
		"production_rate",
		"production_requirement",
		"production_bom",
		"production_change_decide"
	].includes(op)) assertReleased(inv, order);
	if (["production_shift", "production_confirm"].includes(op)) assertLineReady(inv, order);
	const automaticJob = d.automaticFilling && (inv.state.automaticFillingJobs || []).find((j) => j.key === d.automaticFilling.key);
	if (automaticJob && automaticJob.status !== "completed") throw Error("أمر التعبئة التلقائي ينتظر استكمال الجودة والمواد؛ استخدم متابعة التعبئة التلقائية");
	const openShift = () => {
		if (op !== "production_close_shift") {
			const s = ensureAutoShift(inv, order, u, now, "order");
			assertDayOpen(inv, s.day);
			return s;
		}
		const s = d.shifts.find((s) => s.id === b.shiftId);
		if (!s || s.closedAt) throw Error("اختر شفتًا مفتوحًا");
		return s;
	};
	const balanceTotals = () => ({
		input: round$1(inv.state.consumptions.filter((c) => c.orderId === raw.id && !c.reversedAt && c.unit === "KG").reduce((n, c) => n + c.quantity, 0)),
		main: round$1(d.confirmations.filter((c) => c.kind === "main" && c.unit === "KG").reduce((n, c) => n + c.quantity, 0)),
		byproducts: round$1(d.confirmations.filter((c) => c.kind === "byproduct" && c.unit === "KG").reduce((n, c) => n + c.quantity, 0))
	});
	const netIssue = (i) => round$1(i.quantity - inv.state.returns.filter((r) => r.issueId === i.id).reduce((n, r) => n + r.quantity, 0));
	const issues = inv.state.issues.filter((i) => i.orderId === raw.id);
	if (op === "production_rate") {
		d.lineDailyRate = qty(b.lineDailyRate);
		d.rateUpdatedAt = now;
		d.rateUpdatedBy = u.email;
		action = "تعديل معدل الخط التقديري";
	}
	if (op === "production_bom") {
		if (d.bom?.revision === masterData.revision) throw Error("الأمر يستخدم أحدث وصفة بالفعل");
		const previousBom = d.bom;
		const plan = d.cycleVersion >= 4 ? packingPlan(d.code, d.target, inv.materials, d.packingPolicy) : bomPlan(d.code, d.target, inv.materials);
		if (d.cycleVersion >= 4 && isReleased(inv, order)) throw Error("تحديث مخطط الصرف بعد الإطلاق يحتاج أمرًا جديدًا أو مراجعة الاحتياجات المعتمدة");
		if (!plan) throw Error("لا توجد وصفة لهذا المنتج في الملف");
		if (previousBom) {
			d.bomHistory = [...d.bomHistory || [], previousBom];
			d.requirements = (d.requirements || []).filter((r) => r.source !== "BOM" || plan.inputs.some((x) => x.code === r.code));
		}
		d.bom = plan;
		d.requirements = d.requirements || [];
		for (const r of plan.inputs) {
			const old = d.requirements.find((x) => x.code === r.code);
			if (old) if (old.source === "BOM") Object.assign(old, r);
			else {
				old.bomQuantity = r.bomQuantity;
				old.source = "احتياج يدوي محفوظ عند تحديث مخطط الصرف";
			}
			else d.requirements.push(r);
		}
		action = "تحميل مخطط الصرف من " + plan.source;
	}
	if (op === "production_requirement") {
		const m = inv.materials.find((m) => m.code === b.code);
		if (!m) throw Error("اختر المادة");
		d.requirements = d.requirements || [];
		const previous = d.requirements.find((r) => r.code === m.code);
		const reason = d.bom ? required(b.reason, "سبب إضافة أو تعديل الاحتياج") : String(b.reason || "");
		const item = {
			code: m.code,
			name: m.name,
			unit: m.unit,
			quantity: qty(b.quantity),
			bomQuantity: previous?.bomQuantity ?? 0,
			source: d.bom ? previous ? "تعديل احتياج" : "إضافة خارج مخطط الصرف" : "يدوي",
			reason,
			by: u.email,
			at: now
		};
		if (d.cycleVersion >= 4 && isReleased(inv, order)) {
			d.requirementChanges ||= [];
			d.requirementChanges.push({
				id: "CH-" + (d.requirementChanges.length + 1),
				item,
				status: "pending",
				by: u.email,
				at: now
			});
			action = "طلب تعديل احتياج بعد الإطلاق";
		} else {
			const index = d.requirements.findIndex((r) => r.code === m.code);
			if (index >= 0) d.requirements[index] = item;
			else d.requirements.push(item);
			action = "تحديد احتياج " + m.code;
		}
	}
	if (op === "production_change_decide") {
		const r = (d.requirementChanges || []).find((r) => r.id === b.changeId && r.status === "pending");
		if (!r) throw Error("طلب التعديل غير متاح");
		assertApprover(u, r.by, raw.demo);
		if (!["A", "R"].includes(b.decision)) throw Error("اختر قرار الاعتماد");
		if (b.decision === "A") {
			const i = d.requirements.findIndex((n) => n.code === r.item.code);
			if (i >= 0) d.requirements[i] = {
				...r.item,
				approvedBy: u.email,
				approvedAt: now
			};
			else d.requirements.push({
				...r.item,
				approvedBy: u.email,
				approvedAt: now
			});
		}
		Object.assign(r, {
			status: b.decision === "A" ? "approved" : "rejected",
			decisionBy: u.email,
			decisionAt: now,
			reason: required(b.reason, "سبب القرار")
		});
		action = "قرار تعديل احتياج";
	}
	if (op === "production_shift") {
		const date = day$1(b.day), name = required(b.name, "اسم الشفت");
		if (date < d.from || date > d.to) throw Error("اليوم خارج فترة الأمر");
		if (date > new Intl.DateTimeFormat("en-CA", {
			timeZone: "Africa/Cairo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		}).format(/* @__PURE__ */ new Date())) throw Error("لا يمكن فتح شفت مستقبلي");
		if (d.shifts.some((s) => s.day === date && s.name.toLowerCase() === name.toLowerCase())) throw Error("الشفت مسجل لهذا اليوم");
		d.shifts.push({
			id: "SH-" + (d.shifts.length + 1),
			name,
			day: date,
			openedAt: now,
			openedBy: u.email,
			closedAt: null,
			notes: String(b.notes || "").slice(0, 160)
		});
		d.executionStart = d.executionStart || now;
		action = "فتح الشفت " + name;
	}
	if (op === "production_close_shift") {
		const s = openShift();
		assertDayOpen(inv, s.day);
		if (d.cycleVersion >= 4) {
			const metric = (v) => {
				if (v == null || v === "") return null;
				const n = Number(v);
				if (!Number.isFinite(n) || n < 0 || n > 1e9) throw Error("قيمة مورد التشغيل غير صحيحة");
				return n;
			};
			d.handovers ||= [];
			d.handovers.push({
				...shiftMetadata(now),
				id: "HO-" + (d.handovers.length + 1),
				shiftId: s.id,
				day: s.day,
				notes: required(b.notes, "ملاحظات تسليم الشفت"),
				resources: {
					laborHours: metric(b.laborHours),
					machineHours: metric(b.machineHours),
					electricity: metric(b.electricity),
					steam: metric(b.steam),
					water: metric(b.water)
				},
				remaining: wipRows(inv, raw.id).map((r) => ({
					issueId: r.id,
					code: r.code,
					unit: r.unit,
					remaining: r.remaining
				})),
				at: now,
				by: u.email
			});
		}
		s.closedAt = now;
		s.closedBy = u.email;
		action = "إغلاق الشفت " + s.name;
	}
	if (op === "production_handover_accept") {
		const h = (d.handovers || []).find((h) => h.id === b.handoverId && !h.acceptedAt && !h.supersededAt);
		if (!h) throw Error("تسليم الشفت غير متاح");
		if (!raw.demo && h.by === u.email && actualRole(u) !== "admin") throw Error("استلام الشفت بواسطة مستخدم آخر");
		h.acceptedAt = now;
		h.acceptedBy = u.email;
		h.acceptanceNotes = required(b.reason, "ملاحظات استلام الشفت");
		action = "استلام تسليم الشفت";
	}
	if (op === "production_confirm") {
		const s = openShift(), accepted = issues.filter((i) => i.acceptedAt && netIssue(i) > 0);
		const legacy = (d.receipts || []).length || await db.first("SELECT id FROM tickets WHERE demo=? AND status='done' AND json_extract(data,'$.productionOrderId')=? LIMIT 1", [raw.demo, raw.id]);
		if (!accepted.some((i) => i.category === (d.type === "Filling" ? "semi" : "raw")) && !legacy) throw Error("اصرف الخام من المخزن وأكد استلامه داخل الأمر أولًا");
		if (d.type === "Filling" && !accepted.some((i) => i.category === "packaging")) throw Error("أكد استلام مواد التعبئة لأمر Filling");
		if (!["main", "byproduct"].includes(b.kind)) throw Error("اختر نوع الناتج");
		const m = b.kind === "main" ? {
			code: d.code,
			name: d.name,
			unit: d.unit || "KG"
		} : inv.materials.find((m) => m.code === b.code && m.category === "byproduct");
		if (!m || masterData.conflicts.some((x) => x.code === m.code)) throw Error("اختر مادة ناتج جانبي غير متعارضة من الدليل");
		const directBulk = false, warehouse = b.warehouse || d.warehouse || (d.type === "Filling" ? "FG" : "SEMI");
		if (!inv.warehouses.some((w) => w.code === warehouse)) throw Error("اختر مخزن الناتج");
		if (b.batch && inv.lots.some((l) => l.code === m.code && l.batch === b.batch)) throw Error("الباتش مستخدم لهذا المنتج");
		const amount = qty(b.quantity);
		let productionStart = "", productionEnd = "";
		if (b.productionStart || b.productionEnd) {
			for (const key of ["productionStart", "productionEnd"]) if (typeof b[key] !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(b[key]) || !Number.isFinite(Date.parse(b[key])) || Date.parse(b[key]) > Date.parse(now)) throw Error("وقت الإنتاج غير صحيح أو مستقبلي");
			productionStart = new Date(b.productionStart).toISOString();
			productionEnd = new Date(b.productionEnd).toISOString();
			if (productionEnd < productionStart || operatingShift(productionStart).day !== s.day) throw Error("راجع ترتيب وقت الإنتاج ويوم الشفت");
		}
		if (b.parentConfirmationId && !d.confirmations.some((c) => c.id === b.parentConfirmationId && c.kind === "main")) throw Error("اختر دفعة البلك المصدر من نفس الأمر");
		if (d.cycleVersion >= 3 && b.kind === "main") {
			const basic = d.type === "Filling" ? "semi" : "raw";
			const input = accepted.filter((i) => i.category === basic).reduce((n, i) => n + netIssue(i), 0), prior = d.confirmations.filter((c) => c.kind === "main").reduce((n, c) => n + c.quantity, 0);
			if (amount + prior > input) throw Error("الناتج يتجاوز كمية الخام المستلمة للأمر");
			if (d.type === "Filling" && d.bom) for (const r of d.cycleVersion >= 4 ? packingPlan(d.code, prior + amount, inv.materials, d.packingPolicy)?.inputs || [] : d.bom.inputs) {
				const required = d.cycleVersion >= 4 ? r.quantity : r.quantity * (prior + amount) / d.target;
				if (accepted.filter((i) => i.code === r.code).reduce((n, i) => n + netIssue(i), 0) + 1e-4 < required) throw Error("استكمل استلام مكونات مخطط الصرف للكمية المنتجة: " + r.code);
			}
			if (d.type === "Bulk") {
				if (d.cycleVersion >= 4 && b.cipId) {
					const cip = controls(inv.state).cip.find((r) => r.id === b.cipId && r.lineId === d.lineId && r.decision === "A");
					const line = controls(inv.state).machines.find((m) => m.id === d.lineId);
					if (!cip || cip.end < (line?.statusAt || "") || operatingShift(cip.end).day !== s.day) throw Error("اختر دورة CIP معتمدة لنفس الخط ويوم التشغيل بعد آخر صيانة");
				}
			}
		}
		const expiryDate = b.expiryDate ? day$1(b.expiryDate) : "";
		if (expiryDate && expiryDate < dateInCairo(now)) throw Error("صلاحية الناتج تسبق يوم الإنتاج");
		d.confirmations.push({
			productionStart,
			productionEnd,
			parentConfirmationId: b.kind === "byproduct" ? b.parentConfirmationId || null : null,
			expiryDate,
			cipId: b.cipId || null,
			cipRef: String(b.cipRef || "").slice(0, 160),
			tank: String(b.tank || "").slice(0, 160),
			notes: String(b.notes || "").slice(0, 160),
			id: "CF-" + (d.confirmations.length + 1),
			shiftId: s.id,
			day: s.day,
			kind: b.kind,
			code: m.code,
			name: m.name,
			unit: m.unit,
			warehouse,
			quantity: qty(b.quantity),
			directBulk,
			requiresWarehouseReceipt: true,
			batch: b.batch ? required(b.batch, "الباتش") : d.type === "Filling" && b.kind === "main" ? nextOutputBatch(inv, order) : order.batch + "-CF-" + (d.confirmations.length + 1),
			stock: b.kind === "main" ? "Quality Stock" : "Unrestricted Stock",
			at: now,
			by: u.email,
			decision: null
		});
		action = "تسجيل ناتج إلى المخزن";
	}
	if (op === "production_weigh") {
		const c = d.confirmations.find((c) => c.id === b.confirmationId && c.kind === "main");
		if (d.type !== "Filling" || !c) throw Error("اختر دفعة منتج معبأ");
		const s = openShift();
		const count = Number(b.count), gross = qty(b.gross), tare = qty(b.tare), net = round$1(gross - tare);
		if (!Number.isSafeInteger(count) || count <= 0 || count > 1e5 || net <= 0) throw Error("راجع عدد العبوات وأوزانها");
		d.weights ||= [];
		if (net + d.weights.filter((w) => w.confirmationId === c.id).reduce((n, w) => n + w.net, 0) > c.quantity) throw Error("صافي أوزان العبوات يتجاوز كمية الناتج");
		d.weights.push({
			id: "WT-" + (d.weights.length + 1),
			confirmationId: c.id,
			count,
			gross,
			tare,
			net,
			shiftId: s.id,
			day: s.day,
			notes: String(b.notes || "").slice(0, 160),
			at: now,
			by: u.email
		});
		action = "تسجيل أوزان العبوات";
	}
	if (op === "production_balance") {
		const total = balanceTotals(), metric = (v) => {
			if (v == null || v === "") return 0;
			const n = Number(v);
			if (!Number.isFinite(n) || n < 0 || n > 1e9 || Math.abs(n * 1e3 - Math.round(n * 1e3)) > 1e-5) throw Error("كمية موازنة التصنيع غير صحيحة");
			return n;
		};
		const extraInput = metric(b.extraInput), evaporation = metric(b.evaporation), loss = metric(b.loss), remaining = metric(b.remaining);
		if (d.processBalance) d.balanceHistory = [...d.balanceHistory || [], d.processBalance];
		d.processBalance = {
			...total,
			extraInput,
			evaporation,
			loss,
			remaining,
			difference: round$1(total.input + extraInput - total.main - total.byproducts - evaporation - loss - remaining),
			reference: required(b.reason, "مرجع موازنة التصنيع"),
			at: now,
			by: u.email
		};
		action = "تسجيل موازنة التصنيع";
	}
	if (op === "production_balance_decide") {
		const r = d.processBalance;
		if (!r || r.approvedAt) throw Error("موازنة التصنيع غير متاحة للاعتماد");
		assertApprover(u, r.by, raw.demo);
		r.approvedAt = now;
		r.approvedBy = u.email;
		r.approvalReason = required(b.reason, "سبب اعتماد فرق الموازنة");
		action = "اعتماد فرق موازنة التصنيع";
	}
	if (op === "production_waste") {
		const s = openShift(), m = inv.materials.find((m) => m.code === b.code);
		if (!m || !issues.some((i) => i.code === m.code && i.acceptedAt)) throw Error("اختر مادة مصروفة ومستلمة للأمر");
		const amount = qty(b.quantity);
		const total = issues.filter((i) => i.code === m.code && i.acceptedAt).reduce((n, i) => n + netIssue(i), 0);
		const previous = (d.waste || []).filter((w) => w.code === m.code).reduce((n, w) => n + w.quantity, 0);
		const consumed = inv.state.consumptions.filter((c) => c.orderId === raw.id && c.code === m.code && !c.reversedAt).reduce((n, c) => n + c.quantity, 0) + inv.state.packs.filter((c) => c.orderId === raw.id && c.code === m.code && !c.reversedAt).reduce((n, c) => n + c.quantity, 0);
		const pending = inv.state.returnRequests.filter((r) => r.orderId === raw.id && r.code === m.code && !r.acceptedAt && !r.cancelledAt).reduce((n, r) => n + r.quantity, 0);
		if (amount + previous + consumed + pending > total) throw Error("الهالك يتجاوز الكمية المصروفة");
		d.waste = d.waste || [];
		d.waste.push({
			id: "W-" + (d.waste.length + 1),
			code: m.code,
			name: m.name,
			unit: m.unit,
			quantity: amount,
			reason: required(b.reason, "سبب الهالك"),
			shiftId: s.id,
			day: s.day,
			at: now,
			by: u.email
		});
		action = "تسجيل هالك من المواد المصروفة";
	}
	if (op === "production_quality") {
		const c = d.confirmations.find((c) => c.id === b.confirmationId && (c.kind === "main" || d.cycleVersion >= 3));
		if (!c || ["A", "R"].includes(c.decision)) throw Error("الفحص غير متاح أو معتمد بالفعل");
		if (![
			"A",
			"R",
			"H"
		].includes(b.decision)) throw Error("اختر قرار الجودة");
		const color = String(b.color || "").trim(), grade = String(b.grade || "").trim();
		if (b.decision === "A") {
			if (d.cycleVersion >= 3 && d.type === "Filling" && c.kind === "main" && round$1((d.weights || []).filter((w) => w.confirmationId === c.id).reduce((n, w) => n + w.net, 0)) !== c.quantity) throw Error("استكمل تسجيل أوزان العبوات لتطابق كمية الناتج");
			required(color, "قيمة اللون");
			required(grade, "تصنيف الجودة");
		}
		for (const k of ["extra1", "extra2"]) if (Boolean(String(b[k + "Name"] || "").trim()) !== Boolean(String(b[k + "Value"] || "").trim())) throw Error("أدخل اسم الاختبار الإضافي ونتيجته معًا");
		for (const key of [
			"color",
			"grade",
			"extra1Name",
			"extra1Value",
			"extra2Name",
			"extra2Value"
		]) if (String(b[key] || "").length > 160) throw Error("نص الفحص طويل");
		const extraNum = (key, max) => {
			if (b[key] == null || b[key] === "") return null;
			const n = Number(b[key]);
			if (!Number.isFinite(n) || n < 0 || n > max) throw Error("نتيجة التحليل غير صحيحة");
			return n;
		};
		let allowedFinishedCodes = void 0;
		if (d.type === "Bulk" && c.kind === "main" && d.cycleVersion >= 3 && b.decision === "A") {
			const options = packedChoices(inv, d.code);
			if (!Array.isArray(b.allowedFinishedCodes) || !b.allowedFinishedCodes.length || b.allowedFinishedCodes.some((code) => !options.some((m) => m.code === code))) throw Error("حدد المنتجات المعبأة المتوافقة مع نتيجة هذا الباتش");
			allowedFinishedCodes = [...new Set(b.allowedFinishedCodes)];
		}
		let selectedFillingCode = "";
		if (allowedFinishedCodes) {
			selectedFillingCode = String(b.fillingCode || "").trim();
			if (selectedFillingCode && !allowedFinishedCodes.includes(selectedFillingCode)) throw Error("اختر صنف التعبئة من المنتجات المعتمدة لهذا اللون");
			if (!selectedFillingCode) selectedFillingCode = allowedFinishedCodes.includes(c.plannedFillingCode) ? c.plannedFillingCode : allowedFinishedCodes.length === 1 ? allowedFinishedCodes[0] : "";
			if (!selectedFillingCode) throw Error("حدد صنف التعبئة المطلوب ضمن قرار الجودة");
		}
		Object.assign(c, {
			selectedFillingCode,
			...validateQualityApproval(b),
			...qualityDisposition(b),
			allowedFinishedCodes,
			brix: extraNum("brix", 100),
			ph: extraNum("ph", 14),
			decision: b.decision,
			color,
			grade,
			extra1Name: String(b.extra1Name || "").trim(),
			extra1Value: String(b.extra1Value || "").trim(),
			extra2Name: String(b.extra2Name || "").trim(),
			extra2Value: String(b.extra2Value || "").trim(),
			qualityAt: now,
			qualityBy: u.email,
			inspection: c.inspection || "PQ-" + order.id + "-" + c.id,
			stock: b.decision === "A" ? "Unrestricted Stock" : b.decision === "R" ? "Rejected Stock" : "Quality Stock",
			reason: b.decision === "R" ? required(b.reason, "سبب الرفض") : String(b.reason || "").slice(0, 160)
		});
		action = "جودة " + c.id + " — " + b.decision;
	}
	if (op === "production_close") {
		if (d.cycleVersion >= 4 && d.shifts.some((s) => !(d.handovers || []).some((h) => h.shiftId === s.id && !h.supersededAt))) throw Error("سجل تسليم كل شيفت قبل إغلاق الأمر");
		if ((inv.state.automaticFillingJobs || []).some((j) => j.parentOrderId === order.id && j.planned && j.status === "waiting_quality")) throw Error("ألغِ مسودة التعبئة المبكرة غير المستخدمة قبل إغلاق البلك");
		if (d.cycleVersion >= 4) {
			const totals = balanceTotals(), bal = d.processBalance;
			if (d.confirmations.some((c) => c.unit === "KG") && (!bal || bal.input !== totals.input || bal.main !== totals.main || bal.byproducts !== totals.byproducts || bal.difference !== 0 && !bal.approvedAt)) throw Error("راجع موازنة التصنيع واعتمد فرقها قبل الإغلاق");
			if (!["admin", "plant_manager"].includes(actualRole(u))) throw Error("الإغلاق النهائي من صلاحية مدير المصنع");
			if ((d.handovers || []).some((h) => !h.acceptedAt && !h.supersededAt)) throw Error("استكمل استلام تسليمات الشفتات");
			for (const used of inv.state.consumptions.filter((c) => c.orderId === raw.id && !c.reversedAt)) if (controls(inv.state).trace.filter((t) => t.consumptionId === used.id).reduce((n, t) => n + t.quantity, 0) < used.quantity) throw Error("وزّع الاستهلاك على باتشات الناتج قبل الإغلاق");
		}
		if (d.cycleVersion >= 2 && wipRows(inv, raw.id).some((r) => r.remaining > 0)) throw Error("سوِّ المواد المتبقية لدى الإنتاج بالاستهلاك أو المرتجع");
		if (inv.lots.some((l) => l.orderId === raw.id && l.warehousePending && l.quality !== "R")) throw Error("استكمل استلام الناتج بالمخزن");
		if ((inv.state.preparations || []).some((p) => p.orderId === raw.id && p.quantity > p.received + p.cancelled)) throw Error("استلم أو ألغِ التجهيزات المعلقة");
		if (!d.confirmations.length) throw Error("لا يوجد إنتاج مسجل");
		if (d.shifts.some((s) => !s.closedAt && !s.automatic)) throw Error("أغلق الشفتات");
		for (const s of d.shifts) if (s.automatic && !s.closedAt) {
			s.closedAt = now;
			s.closedBy = u.email;
			s.orderEnded = true;
		}
		if (d.confirmations.some((c) => (c.kind === "main" || d.cycleVersion >= 3) && !["A", "R"].includes(c.decision))) throw Error("استكمل فحوص الجودة المعلقة");
		if (issues.some((i) => !i.acceptedAt && netIssue(i) > 0)) throw Error("أكد استلام المواد المصروفة أو أرجعها");
		if (inv.state.reservations.some((r) => r.orderId === raw.id && r.remaining > 0)) throw Error("اصرف أو فك الحجوزات المتبقية");
		d.closedAt = now;
		status = "closed";
		action = "إغلاق الأمر";
	}
	if (fastOutput) {
		applyOutputUsage(inv, order, d.confirmations[d.confirmations.length - 1], b, u, now);
		action = "تسجيل ناتج واستهلاك فعلي في عملية واحدة";
	}
	const inspected = op === "production_quality" ? d.confirmations.find((c) => c.id === b.confirmationId) : null;
	const createFromQuality = inspected?.kind === "main" && d.type === "Bulk" && b.decision === "A" && !(inv.state.automaticFillingJobs || []).some((j) => j.parentOrderId === order.id && j.confirmationId === inspected.id) && !inv.orders.some((o) => o.data.sourceOrderId === order.id && (o.data.sourceLotId === "P-" + order.id + "-" + inspected.id || o.data.sourceOriginLotId === "P-" + order.id + "-" + inspected.id));
	const automaticConfirmation = createFromQuality ? inspected : d.confirmations[d.confirmations.length - 1];
	const automaticDraft = op === "production_confirm" && d.type === "Bulk" && b.kind === "main" || createFromQuality ? prepareAutomaticFilling(inv, order, automaticConfirmation, {
		...b,
		autoFilling: true,
		fillingCode: createFromQuality ? inspected.selectedFillingCode : b.fillingCode
	}, createFromQuality ? {
		email: inspected.by || u.email,
		role: "production"
	} : u, now) : null;
	d.history.push({
		at: now,
		by: u.email,
		action
	});
	tagNewMovements(d, now);
	if (automaticDraft) {
		const c = automaticConfirmation, result = {
			ok: true,
			orderId: order.id,
			confirmationId: c.id,
			batch: c.batch,
			outputLotId: "P-" + order.id + "-" + c.id,
			automaticFillingKey: automaticDraft.job.key,
			...fastOutput ? { operationKey: fastKey(b) } : {}
		};
		if (fastOutput) {
			d.lastFastOutputKey = fastKey(b);
			rememberFast(inv, b, u, result, now);
		}
		const saved = await commitAutomaticOutput(db, inv, order, automaticDraft, result, now, b, u);
		return createFromQuality ? {
			...saved,
			...await safeAutomaticFilling(db, u, raw.demo, { parentOrderId: raw.id })
		} : saved;
	}
	if (fastOutput) return commitOutputUsage(db, inv, order, b, u, now);
	if (!(await db.run("UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND version=? AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=?", [
		JSON.stringify(d),
		status,
		raw.id,
		b.version,
		raw.demo,
		inv.version
	])).changes) throw Error("تغير الأمر أو المخزون؛ حدّث البيانات");
	return {
		ok: true,
		orderId: raw.id,
		...op === "production_quality" ? await safeAutomaticFilling(db, u, raw.demo, { parentOrderId: raw.id }) : {}
	};
}
async function assignTicketOrder() {
	throw Error("اختيار الأمر لم يعد شرطًا للاستلام. استكمل الوزن ثم اصرف الخام من المخزون إلى الأمر.");
}
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
//#region lib/inventory.ts
var categories = {
	other: "مواد مخزنية أخرى",
	raw: "مواد خام",
	packaging: "تعبئة وتغليف",
	additive: "إضافات تصنيع",
	semi: "منتج غير معبأ — Bulk",
	finished: "منتج تام",
	byproduct: "ناتج جانبي"
};
var initialInventory = () => ({
	materials: [],
	salePrices: [],
	warehouses: [
		{
			code: "RAW",
			name: "مخزن الخامات"
		},
		{
			code: "PACK",
			name: "مخزن التعبئة والتغليف"
		},
		{
			code: "SEMI",
			name: "مخزن نصف المصنع"
		},
		{
			code: "FG",
			name: "مخزن المنتج التام"
		},
		{
			code: "OTHER",
			name: "مخزن المواد الأخرى"
		}
	],
	preparations: [],
	entries: [],
	adjustments: [],
	reservations: [],
	issues: [],
	returns: [],
	history: []
});
var required = (v, label) => {
	if (typeof v !== "string" || !v.trim() || v.length > 160) throw Error("أدخل " + label);
	return v.trim();
};
var qty = (v) => {
	const n = Number(v);
	if (v === "" || v == null || !Number.isFinite(n) || n <= 0 || n > 1e9 || Math.abs(n * 1e3 - Math.round(n * 1e3)) > 1e-5) throw Error("الكمية موجبة وبحد أقصى 3 أرقام عشرية");
	return n;
};
var round$1 = (n) => Math.round(n * 1e3) / 1e3;
var parse = (r) => ({
	...r,
	data: typeof r.data === "string" ? JSON.parse(r.data) : r.data
});
async function inventorySnapshot(db, demo) {
	const raw = await db.first("SELECT * FROM inventory WHERE id=?", [demo]);
	const state = raw ? JSON.parse(raw.data) : initialInventory();
	state.salePrices = state.salePrices || [];
	state.preparations = state.preparations || [];
	normalizeCycle(state);
	productionState(state);
	const control = controls(state);
	if (demo && !control.machines.length) control.machines.push({
		id: "DEMO-LINE",
		code: "DEMO-LINE",
		name: "خط تجريبي",
		kind: "line",
		status: "ready",
		costCentre: "",
		by: "DEMO"
	});
	const [tickets, orders, cat] = await Promise.all([
		db.all("SELECT * FROM tickets WHERE demo=?", [demo]),
		db.all("SELECT * FROM production_orders WHERE demo=?", [demo]),
		db.first("SELECT data FROM catalogs WHERE id=?", [demo])
	]);
	const ts = tickets.map(parse), os = orders.map(decodeOrder), catalog = cat ? JSON.parse(cat.data) : defaultCatalog;
	for (const o of os) mergeOrderShifts(state, o);
	const materials = [...state.materials];
	const add = (m) => {
		if (!materials.some((x) => x.code === m.code)) materials.push(m);
	};
	for (const m of masterData.materials) add({ ...m });
	for (const f of catalog.fruits) {
		add({
			code: f.code,
			name: f.name,
			category: "raw",
			unit: "KG",
			warehouse: "RAW"
		});
		const m = materials.find((m) => m.code === f.code);
		if (m) m.receivingKind = "fruit";
	}
	for (const o of os) {
		if (o.data.code) add({
			code: o.data.code,
			name: o.data.name,
			category: o.data.type === "Filling" ? "finished" : "semi",
			unit: o.data.unit || "KG",
			warehouse: o.data.warehouse || (o.data.type === "Filling" ? "FG" : "SEMI")
		});
		for (const p of o.data.packaging || []) add({
			code: p.code,
			name: p.name,
			category: "packaging",
			unit: p.unit,
			warehouse: "PACK"
		});
	}
	demoStock(state, materials, demo);
	const lots = [];
	for (const t of ts.filter((t) => t.status === "done" && t.data.decision === "A")) {
		const d = t.data;
		state.fruitLocations ||= {};
		state.fruitLocations["T-" + t.id] = fruitReceiptLocation(state, t.id);
		let legacy = 0;
		for (const o of os) for (const r of o.data.receipts || []) if (r.ticketId === t.id) legacy += r.quantity;
		if (d.productionOrderId) legacy = Math.max(legacy, Number(d.net));
		lots.push({
			id: "T-" + t.id,
			code: d.fruitCode,
			name: d.fruit,
			category: "raw",
			unit: "KG",
			warehouse: fruitReceiptLocation(state, t.id),
			directFruit: true,
			receiptNumber: "FR-" + String(t.id).padStart(7, "0"),
			receivingOrderId: d.receivingOrderId || null,
			pond: d.pond || "",
			by: d.unloadBy || d.qualityBy || "",
			batch: "B-" + String(t.id).padStart(7, "0"),
			quantity: Number(d.net),
			requiresWarehouseReceipt: false,
			legacy,
			quality: "A",
			at: d.emptyAt,
			source: "FR-" + String(t.id).padStart(7, "0"),
			supplier: d.supplier
		});
	}
	for (const o of os) for (const c of o.data.confirmations || []) {
		const receiptPolicy = bulkReceiptPolicy(state, o, c), directBulk = receiptPolicy.directBulk, category = c.kind === "main" ? o.data.type === "Filling" ? "finished" : "semi" : "byproduct";
		add({
			code: c.code,
			name: c.name,
			category,
			unit: c.unit || o.data.unit || "KG",
			warehouse: receiptPolicy.warehouse
		});
		lots.push({
			id: "P-" + o.id + "-" + c.id,
			code: c.code,
			name: c.name,
			category,
			unit: c.unit || o.data.unit || "KG",
			warehouse: receiptPolicy.warehouse,
			batch: c.batch,
			quantity: c.quantity,
			directBulk,
			requiresWarehouseReceipt: receiptPolicy.requiresWarehouseReceipt,
			legacy: 0,
			quality: c.kind === "byproduct" && (o.data.cycleVersion || 0) < 3 ? "A" : c.decision || "H",
			color: c.color || c.colorDescription || "",
			grade: c.grade || "",
			allowedFinishedCodes: c.allowedFinishedCodes,
			cipRef: c.cipRef,
			expiryDate: c.expiryDate || "",
			productionDate: c.day,
			confirmationId: c.id,
			extra1Name: c.extra1Name || "",
			extra1Value: c.extra1Value || "",
			extra2Name: c.extra2Name || "",
			extra2Value: c.extra2Value || "",
			at: c.at,
			source: o.number + "/" + c.id,
			orderId: o.id
		});
	}
	for (const e of state.entries) {
		const m = materials.find((m) => m.code === e.code);
		lots.push({
			...e,
			name: m?.name || e.name,
			category: m?.category || e.category,
			unit: m?.unit || e.unit,
			quality: e.quality || "A",
			requiresQuality: Boolean(e.requiresQuality || e.requiresWarehouseReceipt && !state.warehouseReceipts.some((r) => r.lotId === e.id)),
			legacy: 0,
			source: e.kind === "opening" ? "رصيد افتتاحي" : "إضافة مخزنية"
		});
	}
	transferLots(state, lots);
	cycleLots(state, lots);
	for (const l of lots) {
		const tx = transferAmounts(state, l.id);
		l.transferred = tx.out;
		l.issued = round$1(state.issues.filter((i) => i.lotId === l.id).reduce((n, i) => n + i.quantity, 0) - state.returns.filter((r) => r.lotId === l.id).reduce((n, r) => n + r.quantity, 0) + l.legacy);
		l.adjustment = state.adjustments.filter((a) => a.lotId === l.id).reduce((n, a) => n + a.quantity, 0);
		l.balance = round$1(l.quantity + l.adjustment - l.issued - l.delivered - l.transferred);
		l.prepared = round$1(state.preparations.filter((p) => p.lotId === l.id).reduce((n, p) => n + p.quantity - p.received - p.cancelled, 0));
		l.reserved = round$1(tx.pending + l.prepared + state.reservations.filter((r) => r.lotId === l.id).reduce((n, r) => n + r.remaining, 0));
		l.available = l.quality === "A" && !l.warehousePending ? round$1(l.balance - l.reserved) : 0;
	}
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Cairo",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).format(/* @__PURE__ */ new Date());
	for (const l of lots) {
		l.expired = expired(l, today);
		if (l.expired) l.available = 0;
		const p = state.salePrices.find((p) => p.code === l.code && p.color === l.color && p.grade === l.grade && p.from <= today && p.to >= today);
		l.salePrice = l.quality === "A" && p ? p.price : null;
	}
	const balances = [];
	for (const l of lots) {
		let b = balances.find((b) => b.code === l.code && b.warehouse === l.warehouse && b.unit === l.unit);
		if (!b) {
			b = {
				code: l.code,
				name: l.name,
				category: l.category,
				warehouse: l.warehouse,
				unit: l.unit,
				balance: 0,
				reserved: 0,
				available: 0,
				pending: 0,
				rejected: 0
			};
			balances.push(b);
		}
		b.balance = round$1(b.balance + l.balance);
		b.reserved = round$1(b.reserved + l.reserved);
		b.available = round$1(b.available + l.available);
		if (l.quality === "H") b.pending = round$1(b.pending + l.balance);
		if (l.quality === "R") b.rejected = round$1(b.rejected + l.balance);
	}
	for (const m of materials) {
		if (masterData.retired.some((r) => r.code === m.code)) continue;
		if (!balances.some((b) => b.code === m.code && b.warehouse === m.warehouse)) balances.push({
			code: m.code,
			name: m.name,
			category: m.category,
			warehouse: m.warehouse,
			unit: m.unit,
			balance: 0,
			reserved: 0,
			available: 0,
			pending: 0,
			rejected: 0
		});
	}
	return {
		masterConflicts: masterData.conflicts,
		version: raw?.version || 0,
		state,
		materials,
		warehouses: state.warehouses,
		lots,
		balances,
		orders: os
	};
}
async function inventoryOperation(db, u, b) {
	u = operator(u, b.action);
	const op = b.action, demo = b.demo === true ? 1 : 0;
	const admin = [
		"inventory_price",
		"inventory_material",
		"inventory_warehouse",
		"inventory_adjust"
	];
	const production = [
		"inventory_reserve",
		"inventory_release",
		"inventory_accept"
	];
	const shared = [
		"inventory_transfer",
		"inventory_transfer_accept",
		"inventory_transfer_cancel",
		"inventory_labels",
		"inventory_label_link"
	];
	const warehouse = [
		"inventory_opening",
		"inventory_add",
		"inventory_issue",
		"inventory_prepare_bom",
		"inventory_cancel_prepare",
		"inventory_return"
	];
	if (u.role !== "admin" && !(production.includes(op) && u.role === "production") && !(warehouse.includes(op) && u.role === "warehouse") && !(shared.includes(op) && ["production", "warehouse"].includes(u.role))) throw Error("لا توجد صلاحية لهذه الحركة");
	if (![
		...admin,
		...production,
		...warehouse,
		...shared
	].includes(op)) throw Error("إجراء مخزني غير معروف");
	const inv = await inventorySnapshot(db, demo);
	if (!Number.isInteger(b.inventoryVersion) || inv.version !== b.inventoryVersion) throw Error("الأرصدة تغيرت من جهاز آخر؛ حدّث الصفحة");
	const d = inv.state, now = (/* @__PURE__ */ new Date()).toISOString(), id = "M-" + crypto.randomUUID();
	let order = null;
	const orderOps = [
		...production,
		"inventory_issue",
		"inventory_prepare_bom",
		"inventory_cancel_prepare",
		"inventory_return"
	];
	if (![
		"inventory_labels",
		"inventory_label_link",
		"inventory_material",
		"inventory_warehouse",
		"inventory_price"
	].includes(op)) assertDayOpen(inv, operatingShift(now).day);
	if (orderOps.includes(op)) {
		order = inv.orders.find((o) => o.id === Number(b.orderId));
		if (!order || order.status !== "open" || order.version !== b.orderVersion) throw Error("اختر أمرًا مفتوحًا وحدّث بياناته");
		assertReleased(inv, order);
		assertScope(inv, u, { lineId: order.data.lineId });
		if (op === "inventory_accept") ensureAutoShift(inv, order, u, now);
	}
	const lot = inv.lots.find((l) => l.id === b.lotId), material = inv.materials.find((m) => m.code === b.code);
	const needLot = () => {
		if (lot) {
			assertWarehouse(u, lot.warehouse);
			assertScope(inv, u, { warehouse: lot.warehouse });
			assertUsable(lot, dateInCairo(now));
		}
		if (lot && materialBlocked(lot.code)) throw Error("كود المادة معلق لتعارض الماستر داتا");
		if (!lot || lot.quality !== "A" || lot.warehousePending) throw Error("اختر باتش متاحًا ومعتمد الجودة");
		return lot;
	};
	const needWarehouse = () => {
		assertWarehouse(u, b.warehouse);
		assertScope(inv, u, { warehouse: b.warehouse });
		if (!inv.warehouses.some((w) => w.code === b.warehouse)) throw Error("اختر المخزن");
		return b.warehouse;
	};
	const materialBlocked = (code) => masterData.conflicts.some((x) => x.code === code) || masterData.retired.some((x) => x.code === code);
	if (b.code && materialBlocked(b.code)) throw Error("الكود مكرر بتوصيفات مختلفة في الماستر داتا؛ راجعه قبل الاستخدام");
	let description = newInventoryAction(inv, u, b, now, id) || "";
	if (op === "inventory_price") {
		if (!material || !["semi", "finished"].includes(material.category)) throw Error("اختر منتجًا نصف مصنع أو تام");
		const from = required(b.from, "بداية السعر"), to = required(b.to, "نهاية السعر");
		for (const date of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error("تاريخ السعر غير صحيح");
		if (from > to) throw Error("فترة السعر غير صحيحة");
		const color = required(b.color, "اللون"), grade = required(b.grade, "تصنيف الجودة");
		const priceId = b.priceId || id;
		if (b.priceId && !d.salePrices.some((p) => p.id === b.priceId)) throw Error("السعر غير موجود");
		if (d.salePrices.some((p) => p.id !== priceId && p.code === material.code && p.color === color && p.grade === grade && from <= p.to && to >= p.from)) throw Error("تداخل أسعار لنفس المنتج واللون والجودة");
		d.salePrices = d.salePrices.filter((p) => p.id !== priceId);
		d.salePrices.push({
			id: priceId,
			code: material.code,
			color,
			grade,
			from,
			to,
			price: qty(b.price),
			unit: material.unit,
			at: now,
			by: u.email
		});
		description = "حفظ سعر بيع " + material.code;
	}
	if (op === "inventory_material") {
		const code = required(b.code, "كود المادة"), name = required(b.name, "اسم المادة");
		if (!categories[b.category] || ![
			"KG",
			"PC",
			"L",
			"M"
		].includes(b.unit)) throw Error("اختر تصنيف المادة ووحدتها");
		needWarehouse();
		const existing = inv.materials.find((m) => m.code === code);
		if (existing && (existing.unit !== b.unit || existing.category !== b.category)) throw Error("لا يمكن تغيير وحدة أو تصنيف كود موجود؛ أنشئ كودًا جديدًا");
		const minimum = b.minimum == null ? existing?.minimum ?? null : b.minimum === "" ? null : Number(b.minimum);
		if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1e9 || Math.abs(minimum * 1e3 - Math.round(minimum * 1e3)) > 1e-5)) throw Error("الحد الأدنى يجب أن يكون صفرًا أو كمية موجبة حتى 3 أرقام عشرية");
		const m = {
			code,
			name,
			category: b.category,
			unit: b.unit,
			warehouse: b.warehouse,
			minimum,
			returnable: b.returnable === void 0 ? Boolean(existing?.returnable) : b.returnable === true,
			qcProfile: b.qcProfile === void 0 ? existing?.qcProfile || "" : String(b.qcProfile || ""),
			requiresQuality: b.requiresQuality === void 0 ? Boolean(existing?.requiresQuality) : b.requiresQuality === true
		};
		if (m.qcProfile && !materialSpecifications[m.qcProfile]) throw Error("اختر مواصفة فحص معروفة");
		if (m.returnable && (m.category !== "packaging" || m.unit !== "PC")) throw Error("العهدة تتطلب صنف تعبئة بوحدة قطعة");
		d.materials = d.materials.filter((x) => x.code !== code);
		d.materials.push(m);
		description = "حفظ المادة " + code;
	}
	if (op === "inventory_warehouse") {
		const code = required(b.code, "كود المخزن"), name = required(b.name, "اسم المخزن");
		const w = d.warehouses.find((w) => w.code === code);
		if (w) w.name = name;
		else d.warehouses.push({
			code,
			name
		});
		description = "حفظ المخزن " + code;
	}
	if (["inventory_opening", "inventory_add"].includes(op)) {
		if (!material) throw Error("اختر مادة من الدليل");
		if (op === "inventory_add" && material.receivingKind === "fruit") throw Error("استخدم شاشة استلام الثمار لتسجيل شحنة الثمار وفحصها وتذكرتها");
		if (masterData.materials.some((m) => m.code === material.code && m.phantom)) throw Error("مجموعة التعبئة افتراضية؛ أدخل أرصدة مكوناتها الفعلية");
		if (["semi", "finished"].includes(material.category) && u.role !== "admin") throw Error("الرصيد الافتتاحي للمنتجات يعتمد بواسطة المدير؛ الناتج الجديد يسجل من أمر التصنيع");
		const incoming = {};
		for (const [key] of incomingDataFields) incoming[key] = String(b[key] || "").trim().slice(0, 160);
		for (const key of ["productionDate", "expiryDate"]) if (incoming[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(incoming[key]) || !Number.isFinite(Date.parse(incoming[key])) || new Date(incoming[key]).toISOString().slice(0, 10) !== incoming[key])) throw Error("تاريخ الوارد غير صحيح");
		if (incoming.productionDate && incoming.expiryDate && incoming.expiryDate < incoming.productionDate) throw Error("الصلاحية تسبق الإنتاج");
		d.entries.push({
			...incoming,
			id,
			code: material.code,
			name: material.name,
			category: material.category,
			unit: material.unit,
			warehouse: needWarehouse(),
			batch: required(b.batch, "الباتش"),
			quantity: qty(b.quantity),
			requiresWarehouseReceipt: op === "inventory_add",
			requiresQuality: op === "inventory_add",
			qcProfile: materialProfile(material),
			kind: op === "inventory_opening" ? "opening" : "addition",
			reason: required(b.reason, "مرجع الإضافة"),
			at: now,
			by: u.email
		});
		description = "إضافة مخزون " + material.code;
	}
	if (op === "inventory_adjust") throw Error("استخدم طلب فرق الجرد واعتماد مدير المصنع");
	if (op === "inventory_reserve") {
		needLot();
		assertProductionLot(order, lot);
		const amount = qty(b.quantity);
		if (amount > lot.available) throw Error("الرصيد المتاح لا يكفي للحجز");
		d.reservations.push({
			id,
			orderId: order.id,
			lotId: lot.id,
			code: lot.code,
			quantity: amount,
			remaining: amount,
			at: now,
			by: u.email
		});
		description = "حجز للأمر " + order.number;
	}
	if (op === "inventory_release") {
		const r = d.reservations.find((r) => r.id === b.reservationId && r.orderId === order.id && r.remaining > 0);
		if (!r) throw Error("الحجز غير متاح");
		const held = inv.lots.find((l) => l.id === r.lotId);
		if (held) {
			assertWarehouse(u, held.warehouse);
			assertScope(inv, u, { warehouse: held.warehouse });
		}
		r.remaining = 0;
		r.releasedAt = now;
		r.releasedBy = u.email;
		description = "فك حجز " + r.id;
	}
	const prepare = (lotId, amount) => {
		const l = inv.lots.find((x) => x.id === lotId);
		if (l) {
			assertWarehouse(u, l.warehouse);
			assertScope(inv, u, { warehouse: l.warehouse });
			assertUsable(l, dateInCairo(now));
			if (order.data.cycleVersion >= 4 && l.unit === "PC" && !Number.isInteger(amount)) throw Error("القطع تصرف بأعداد صحيحة");
		}
		if (l) assertProductionLot(order, l);
		if (!l || l.quality !== "A" || l.warehousePending || materialBlocked(l.code)) throw Error("اختر باتش متاحًا لمادة فعلية");
		if (b.supplyRequestId) {
			const req = d.supplyRequests.find((r) => r.id === b.supplyRequestId && r.orderId === order.id && r.code === l.code && !r.cancelledAt);
			const prepared = d.preparations.filter((p) => p.supplyRequestId === b.supplyRequestId).reduce((n, p) => n + p.quantity - p.cancelled, 0);
			if (!req || amount > round$1(req.quantity - prepared)) throw Error("التجهيز يتجاوز طلب الصرف");
		}
		const own = d.reservations.filter((r) => r.orderId === order.id && r.lotId === l.id && r.remaining > 0), ownQty = own.reduce((n, r) => n + r.remaining, 0);
		const added = d.preparations.filter((p) => p.lotId === l.id && p.requestId === id).reduce((n, p) => n + p.quantity, 0);
		if (amount > round$1(l.available + ownQty - added)) throw Error("الرصيد المتاح لا يكفي لتجهيز " + l.code);
		let remaining = amount;
		for (const r of own) {
			const take = Math.min(r.remaining, remaining);
			r.remaining = round$1(r.remaining - take);
			remaining = round$1(remaining - take);
		}
		const p = {
			id: "PRE-" + crypto.randomUUID(),
			requestId: id,
			supplyRequestId: b.supplyRequestId || null,
			orderId: order.id,
			lotId: l.id,
			code: l.code,
			name: l.name,
			category: l.category,
			unit: l.unit,
			warehouse: l.warehouse,
			batch: l.batch,
			quantity: amount,
			received: 0,
			cancelled: 0,
			sourceOrderId: l.orderId || null,
			sourceReference: l.source,
			at: now,
			by: u.email
		};
		d.preparations.push(p);
		return p;
	};
	if (op === "inventory_issue") {
		prepare(b.lotId, qty(b.quantity));
		description = "تجهيز وحجز مادة للأمر " + order.number;
	}
	if (op === "inventory_prepare_bom") {
		if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200) throw Error("اختر مواد وكميات للتجهيز");
		if (new Set(b.lines.map((x) => x.lotId)).size !== b.lines.length) throw Error("لا تكرر نفس الباتش؛ اجمع كميته في بند واحد");
		const totals = /* @__PURE__ */ new Map();
		for (const line of b.lines) {
			const l = inv.lots.find((x) => x.id === line.lotId);
			if (!l) throw Error("الباتش غير موجود");
			totals.set(l.code, round$1((totals.get(l.code) || 0) + qty(line.quantity)));
		}
		for (const [code, amount] of totals) {
			const req = (order.data.requirements || []).find((r) => r.code === code);
			if (!req) throw Error("أضف احتياج المادة إلى الأمر أولًا: " + code);
			const actual = d.issues.filter((i) => i.orderId === order.id && i.code === code).reduce((n, i) => n + i.quantity - d.returns.filter((r) => r.issueId === i.id).reduce((v, r) => v + r.quantity, 0), 0);
			const pending = d.preparations.filter((p) => p.orderId === order.id && p.code === code).reduce((n, p) => n + p.quantity - p.received - p.cancelled, 0);
			if (amount > round$1(req.quantity - actual - pending)) throw Error("الكمية أكبر من المتبقي للاحتياج " + code + "؛ عدّل الاحتياج إذا لزم");
		}
		for (const line of b.lines) prepare(line.lotId, qty(line.quantity));
		description = "تجهيز احتياجات مخطط الصرف للأمر " + order.number;
	}
	if (op === "inventory_cancel_prepare") {
		const p = d.preparations.find((p) => p.id === b.preparationId && p.orderId === order.id);
		if (!p || p.quantity <= p.received + p.cancelled) throw Error("لا توجد كمية معلقة");
		p.cancelled = round$1(p.quantity - p.received);
		p.cancelledAt = now;
		p.cancelledBy = u.email;
		p.reason = required(b.reason, "سبب إلغاء التجهيز");
		description = "إلغاء متبقي التجهيز للأمر " + order.number;
	}
	if (op === "inventory_accept") {
		const shift = ensureAutoShift(inv, order, u, now);
		if (b.preparationId) {
			const p = d.preparations.find((p) => p.id === b.preparationId && p.orderId === order.id);
			const amount = qty(b.quantity);
			if (p && order.data.cycleVersion >= 4 && p.unit === "PC" && !Number.isInteger(amount)) throw Error("القطع تستلم بأعداد صحيحة");
			if (!p || amount > round$1(p.quantity - p.received - p.cancelled)) throw Error("الاستلام يتجاوز المتبقي أو تم تأكيده بالفعل");
			const l = inv.lots.find((x) => x.id === p.lotId);
			if (l) {
				assertWarehouse(u, l.warehouse);
				assertScope(inv, u, { warehouse: l.warehouse });
				assertUsable(l, dateInCairo(now));
				assertProductionLot(order, l);
			}
			if (!l || l.quality !== "A" || l.warehousePending || amount > l.balance) throw Error("الباتش غير متاح للاستلام");
			p.received = round$1(p.received + amount);
			d.issues.push({
				id,
				number: "GI-" + String(d.issues.length + 1).padStart(7, "0"),
				orderId: order.id,
				lotId: p.lotId,
				code: p.code,
				name: p.name,
				category: p.category,
				unit: p.unit,
				warehouse: p.warehouse,
				batch: p.batch,
				quantity: amount,
				at: now,
				by: u.email,
				acceptedAt: now,
				acceptedBy: u.email,
				shiftId: shift.id,
				day: shift.day,
				preparationId: p.id,
				sourceOrderId: p.sourceOrderId,
				sourceReference: p.sourceReference,
				notes: String(b.notes || "").slice(0, 160)
			});
		} else {
			const issue = d.issues.find((i) => i.id === b.issueId && i.orderId === order.id);
			if (!issue || issue.acceptedAt) throw Error("اختر حركة قديمة لم تُستلم");
			issue.acceptedAt = now;
			issue.acceptedBy = u.email;
			issue.shiftId = shift.id;
			issue.day = shift.day;
		}
		description = "تأكيد استلام وخصم للأمر " + order.number;
	}
	if (op === "inventory_return") {
		const issue = d.issues.find((i) => i.id === b.issueId && i.orderId === order.id);
		if (!issue) throw Error("اختر حركة صرف من الأمر");
		assertWarehouse(u, issue.warehouse);
		assertScope(inv, u, { warehouse: issue.warehouse });
		const amount = qty(b.quantity);
		const wip = wipRows(inv, order.id).find((r) => r.id === issue.id);
		if (wip && amount > wip.free) throw Error("المرتجع يتجاوز المتبقي لدى الإنتاج");
		const returned = d.returns.filter((r) => r.issueId === issue.id).reduce((n, r) => n + r.quantity, 0);
		if (amount > round$1(issue.quantity - returned)) throw Error("المرتجع أكبر من المصروف المتبقي");
		const codeNet = d.issues.filter((i) => i.orderId === order.id && i.code === issue.code).reduce((n, i) => n + i.quantity - d.returns.filter((r) => r.issueId === i.id).reduce((a, r) => a + r.quantity, 0), 0);
		const waste = (order.data.waste || []).filter((w) => w.code === issue.code).reduce((n, w) => n + w.quantity, 0);
		if (round$1(codeNet - amount) < waste) throw Error("المرتجع يتعارض مع كمية هالك معتمدة");
		d.returns.push({
			id,
			issueId: issue.id,
			orderId: order.id,
			lotId: issue.lotId,
			quantity: amount,
			reason: required(b.reason, "سبب المرتجع"),
			at: now,
			by: u.email
		});
		description = "مرتجع من الأمر " + order.number;
	}
	d.history.push({
		id,
		at: now,
		by: u.email,
		action: description
	});
	tagNewMovements(d, now);
	const guard = order ? " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND status='open' AND version=?)" : "";
	const args = order ? [
		order.id,
		demo,
		order.version
	] : [];
	if (!(inv.version === 0 ? await db.run(`INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1${guard}`, [
		demo,
		JSON.stringify(d),
		...args
	]) : await db.run(`UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?${guard}`, [
		JSON.stringify(d),
		demo,
		inv.version,
		...args
	])).changes) throw Error("تعارض تحديث الأرصدة أو الأمر؛ حدّث الصفحة وأعد المحاولة");
	return {
		ok: true,
		...op === "inventory_transfer_accept" || op === "inventory_opening" && b.warehouse === "PROD" ? await safeAutomaticFilling(db, u, demo) : {}
	};
}
//#endregion
//#region lib/fast-plan.ts
var round = (v) => Math.round(v * 1e3) / 1e3;
var amount = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
function pendingPreparation(inv, p) {
	return round(p.quantity - p.received - p.cancelled);
}
function remainingRequirement(inv, o, code) {
	const need = (o.data.requirements || []).find((r) => r.code === code);
	if (!need) return 0;
	const issued = (inv.state.issues || []).filter((i) => i.orderId === o.id && i.code === code).reduce((sum, i) => sum + i.quantity - (inv.state.returns || []).filter((r) => r.issueId === i.id).reduce((v, r) => v + r.quantity, 0), 0);
	return round(Math.max(0, need.quantity - issued));
}
function usageProposal(inv, o, output) {
	if (!inv || !o || !Number.isFinite(output) || output <= 0) return {
		lines: [],
		shortages: []
	};
	let plan = null;
	try {
		plan = packingPlan(o.data.code, output, inv.materials, o.data.packingPolicy || "partial");
	} catch (e) {
		throw e;
	}
	const wip = wipRows(inv, o.id).filter((r) => r.free > 0), lines = [], shortages = [];
	for (const r of o.data.requirements || []) {
		const standard = plan?.inputs.find((p) => p.code === r.code && p.unit === r.unit);
		let needed = standard && r.source === "BOM" ? standard.quantity : amount(r.quantity) * output / Math.max(1, amount(o.data.target));
		if (r.unit === "PC") needed = Math.ceil(needed - 1e-9);
		needed = round(needed);
		let left = needed;
		for (const i of wip.filter((i) => i.code === r.code && i.unit === r.unit).sort((a, b) => String(a.acceptedAt || a.at).localeCompare(String(b.acceptedAt || b.at)))) {
			let quantity = round(Math.min(left, i.free));
			if (i.unit === "PC") quantity = Math.floor(quantity);
			if (quantity <= 0) continue;
			lines.push({
				issueId: i.id,
				code: i.code,
				name: i.name,
				batch: i.batch,
				category: i.category,
				unit: i.unit,
				quantity,
				plannedQuantity: quantity,
				max: i.free
			});
			left = round(left - quantity);
			if (!left) break;
		}
		if (left > 0) shortages.push({
			code: r.code,
			name: r.name,
			unit: r.unit,
			quantity: left
		});
	}
	for (const i of wip) if (!lines.some((l) => l.issueId === i.id)) lines.push({
		issueId: i.id,
		code: i.code,
		name: i.name,
		batch: i.batch,
		category: i.category,
		unit: i.unit,
		quantity: 0,
		plannedQuantity: 0,
		max: i.free
	});
	return {
		lines,
		shortages
	};
}
//#endregion
//#region lib/fast-operations.ts
var stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
var fingerprint = (b) => JSON.stringify(stable(Object.fromEntries(Object.entries(b).filter(([k]) => ![
	"idempotencyKey",
	"inventoryVersion",
	"orderVersion",
	"version"
].includes(k)))));
function fastKey(b) {
	if (typeof b.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(b.idempotencyKey)) throw Error("معرف العملية غير صالح؛ أعد فتح النموذج");
	return b.idempotencyKey;
}
function completedFast(inv, b, u) {
	const key = fastKey(b), prior = (inv.state.fastOperations || []).find((r) => r.key === key);
	if (!prior) return null;
	if (prior.action !== b.action || prior.by !== u.email || prior.fingerprint !== fingerprint(b)) throw Error("معرف العملية مستخدم بطلب مختلف؛ أعد فتح النموذج");
	return {
		...prior.result,
		replayed: true
	};
}
function rememberFast(inv, b, u, result, now) {
	inv.state.fastOperations ||= [];
	inv.state.fastOperations.push({
		key: fastKey(b),
		action: b.action,
		by: u.email,
		at: now,
		fingerprint: fingerprint(b),
		result
	});
}
var serial$1 = (prefix, list) => prefix + "-" + String(list.length + 1).padStart(7, "0");
var blocked = (code) => masterData.conflicts.some((m) => m.code === code) || masterData.retired.some((m) => m.code === code);
async function groupedInventoryOperation(db, user, b) {
	const u = operator(user, b.action), role = actualRole(u), prepare = b.action === "inventory_prepare_group";
	if (!["inventory_prepare_group", "inventory_accept_group"].includes(b.action) || !(prepare ? [
		"admin",
		"warehouse",
		"store_production"
	] : [
		"admin",
		"production",
		"store_production"
	]).includes(role)) throw Error("لا توجد صلاحية لهذه الحركة");
	const demo = b.demo === true ? 1 : 0, inv = await inventorySnapshot(db, demo), prior = completedFast(inv, b, u);
	if (prior) return prior;
	if (!Number.isSafeInteger(b.inventoryVersion) || inv.version !== b.inventoryVersion) throw Error("الأرصدة تغيرت؛ حدّث البيانات وأعد مراجعة المجموعة");
	const o = inv.orders.find((o) => o.id === b.orderId);
	if (!o || o.status !== "open" || o.version !== b.orderVersion) throw Error("الأمر مغلق أو تغير؛ أعد مراجعة المجموعة");
	assertReleased(inv, o);
	assertScope(inv, u, { lineId: o.data.lineId });
	const now = (/* @__PURE__ */ new Date()).toISOString();
	assertDayOpen(inv, operatingShift(now).day);
	if (b.confirm !== true) throw Error("أكد مراجعة المواد والكميات الفعلية");
	if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200) throw Error("اختر من بند واحد إلى 200 بند");
	const keys = b.lines.map((l) => prepare ? l.lotId : l.preparationId || l.lotId);
	if (keys.some((k) => typeof k !== "string" || !k) || new Set(keys).size !== keys.length) throw Error("لا تكرر نفس بند المادة أو الباتش");
	const d = inv.state, id = "GROUP-" + crypto.randomUUID(), codeTotals = /* @__PURE__ */ new Map(), lotTotals = /* @__PURE__ */ new Map(), numbers = [], groupItems = [];
	const own = (lotId) => d.reservations.filter((r) => r.orderId === o.id && r.lotId === lotId && r.remaining > 0);
	const takeReservations = (lotId, quantity) => {
		let left = quantity;
		for (const r of own(lotId)) {
			const take = Math.min(left, r.remaining);
			r.remaining = round$1(r.remaining - take);
			left = round$1(left - take);
			if (!left) break;
		}
	};
	const rows = b.lines.map((line) => {
		const p = !prepare && line.preparationId ? d.preparations.find((p) => p.id === line.preparationId && p.orderId === o.id) : null;
		if (!prepare && line.preparationId && !p) throw Error("التجهيز غير موجود لهذا الأمر");
		const l = inv.lots.find((l) => l.id === (p?.lotId || line.lotId));
		if (!l || blocked(l.code) || l.quality !== "A" || l.warehousePending) throw Error("اختر مواد معتمدة ومتاحة للاستلام");
		assertWarehouse(u, l.warehouse);
		assertScope(inv, u, { warehouse: l.warehouse });
		assertUsable(l, dateInCairo(now));
		assertProductionLot(o, l);
		const quantity = qty(line.quantity);
		if (l.unit === "PC" && !Number.isInteger(quantity)) throw Error("عدد القطع يجب أن يكون صحيحًا");
		if (!(o.data.requirements || []).find((r) => r.code === l.code && r.unit === l.unit)) throw Error("المادة خارج احتياجات الأمر المعتمدة: " + l.code);
		if (prepare && l.directFruit) throw Error("الثمار تصرف مباشرة من الحوض بمعرفة الإنتاج");
		if (!prepare && !p && !(l.directFruit && l.category === "raw" && l.warehouse === "PROD" && o.data.type === "Bulk")) throw Error("مواد المخزن تحتاج تجهيزًا قبل تأكيد استلام الإنتاج");
		if (p && quantity > pendingPreparation(inv, p)) throw Error("الاستلام يتجاوز متبقي التجهيز");
		const ownQty = own(l.id).reduce((n, r) => n + r.remaining, 0);
		if ((prepare || !p) && quantity > round$1(l.available + ownQty)) throw Error("الكمية تتجاوز المتاح للباتش " + l.batch);
		codeTotals.set(l.code, round$1((codeTotals.get(l.code) || 0) + quantity));
		lotTotals.set(l.id, round$1((lotTotals.get(l.id) || 0) + quantity));
		return {
			l,
			p,
			quantity
		};
	});
	for (const [code, total] of codeTotals) {
		const pending = prepare ? d.preparations.filter((p) => p.orderId === o.id && p.code === code).reduce((n, p) => n + Math.max(0, pendingPreparation(inv, p)), 0) : 0;
		if (total > round$1(remainingRequirement(inv, o, code) - pending)) throw Error("المجموعة تتجاوز متبقي احتياج المادة " + code);
	}
	for (const [lotId, total] of lotTotals) if (total > inv.lots.find((l) => l.id === lotId).balance) throw Error("مجموع البنود يتجاوز الرصيد الفعلي للباتش");
	const shift = prepare ? operatingShift(now) : ensureAutoShift(inv, o, u, now);
	assertDayOpen(inv, shift.day);
	for (const { l } of rows) assertUsable(l, dateInCairo(now));
	for (const { l, p, quantity } of rows) if (prepare) {
		takeReservations(l.id, quantity);
		let left = quantity;
		const requests = (d.supplyRequests || []).filter((r) => r.orderId === o.id && r.code === l.code && !r.cancelledAt).sort((a, b) => String(a.at).localeCompare(String(b.at)));
		const pieces = [];
		for (const r of requests) {
			const allocated = d.preparations.filter((p) => p.supplyRequestId === r.id).reduce((n, p) => n + p.quantity - p.cancelled, 0), q = round$1(Math.min(left, Math.max(0, r.quantity - allocated)));
			if (q > 0) {
				pieces.push({
					quantity: q,
					supplyRequestId: r.id
				});
				left = round$1(left - q);
			}
			if (!left) break;
		}
		if (left > 0) pieces.push({
			quantity: left,
			supplyRequestId: null
		});
		for (const piece of pieces) {
			const preparation = {
				id: "PRE-" + crypto.randomUUID(),
				requestId: id,
				groupKey: fastKey(b),
				orderId: o.id,
				lotId: l.id,
				code: l.code,
				name: l.name,
				category: l.category,
				unit: l.unit,
				warehouse: l.warehouse,
				batch: l.batch,
				received: 0,
				cancelled: 0,
				sourceOrderId: l.orderId || null,
				sourceReference: l.source,
				at: now,
				by: u.email,
				...piece
			};
			d.preparations.push(preparation);
			groupItems.push(preparation.id);
		}
	} else {
		if (p) p.received = round$1(p.received + quantity);
		else takeReservations(l.id, quantity);
		const number = serial$1("GI", d.issues);
		numbers.push(number);
		d.issues.push({
			id: "ISS-" + crypto.randomUUID(),
			number,
			groupId: id,
			groupKey: fastKey(b),
			orderId: o.id,
			lotId: l.id,
			code: l.code,
			name: l.name,
			category: l.category,
			unit: l.unit,
			warehouse: l.warehouse,
			batch: l.batch,
			quantity,
			at: now,
			by: u.email,
			acceptedAt: now,
			acceptedBy: u.email,
			shiftId: shift.id,
			day: shift.day,
			preparationId: p?.id || null,
			directFruit: !p && l.directFruit === true,
			sourceOrderId: l.orderId || null,
			sourceReference: l.source,
			notes: String(b.notes || "").slice(0, 160)
		});
	}
	const result = {
		ok: true,
		orderId: o.id,
		groupId: id,
		numbers,
		preparationIds: groupItems
	};
	rememberFast(inv, b, u, result, now);
	d.history.push({
		id,
		at: now,
		by: u.email,
		action: prepare ? "تجهيز مجموعة مواد للأمر " + o.number : "استلام وصرف مجموعة مواد للأمر " + o.number
	});
	tagNewMovements(d, now);
	const guard = " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND status='open' AND version=?)", args = [
		o.id,
		demo,
		o.version
	];
	if (!(inv.version === 0 ? await db.run("INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1" + guard, [
		demo,
		JSON.stringify(d),
		...args
	]) : await db.run("UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?" + guard, [
		JSON.stringify(d),
		demo,
		inv.version,
		...args
	])).changes) {
		const retry = completedFast(await inventorySnapshot(db, demo), b, u);
		if (retry) return retry;
		throw Error("تعارض تحديث المجموعة؛ حدّث البيانات وأعد المراجعة");
	}
	return result;
}
function applyOutputUsage(inv, o, c, b, u, now) {
	assertDayOpen(inv, c.day);
	if (b.confirmUsage !== true) throw Error("أكد الناتج والاستهلاك الفعلي معًا");
	if (c.kind !== "main") throw Error("التسجيل المجمع متاح للناتج الأساسي؛ استخدم شاشة النواتج الجانبية");
	if (!Array.isArray(b.usageRows) || !b.usageRows.length || b.usageRows.length > 200 || new Set(b.usageRows.map((r) => r.issueId)).size !== b.usageRows.length) throw Error("راجع بنود الاستهلاك دون تكرار حركة صرف");
	const proposal = usageProposal(inv, o, c.quantity), expected = /* @__PURE__ */ new Map(), actual = /* @__PURE__ */ new Map(), wip = wipRows(inv, o.id);
	for (const r of proposal.lines) expected.set(r.code, round$1((expected.get(r.code) || 0) + r.plannedQuantity));
	for (const r of proposal.shortages) expected.set(r.code, round$1((expected.get(r.code) || 0) + r.quantity));
	const rows = b.usageRows.map((r) => {
		const i = wip.find((i) => i.id === r.issueId);
		if (!i || blocked(i.code)) throw Error("اختر مواد مستلمة لنفس الأمر");
		const quantity = qty(r.quantity);
		if (quantity > i.free) throw Error("الاستهلاك يتجاوز المتبقي لدى الإنتاج: " + i.code);
		if (i.unit === "PC" && !Number.isInteger(quantity)) throw Error("عدد العبوات المستهلكة يجب أن يكون صحيحًا");
		if (!(o.data.requirements || []).some((need) => need.code === i.code && need.unit === i.unit)) throw Error("الاستهلاك خارج احتياجات الأمر المعتمدة");
		actual.set(i.code, round$1((actual.get(i.code) || 0) + quantity));
		return {
			i,
			quantity
		};
	});
	const basic = o.data.type === "Filling" ? "semi" : "raw", basicRows = rows.filter((r) => r.i.category === basic);
	if (!basicRows.length) throw Error("حدد الاستهلاك الفعلي للخامة الأساسية");
	if (c.unit === "KG" && basicRows.filter((r) => r.i.unit === "KG").reduce((n, r) => n + r.quantity, 0) + 1e-4 < c.quantity) throw Error("كمية الناتج تتجاوز الاستهلاك الفعلي للخامة الأساسية");
	if (o.data.type === "Filling" && !rows.some((r) => r.i.category === "packaging")) throw Error("حدد مواد التعبئة المستخدمة في الباتش");
	const codes = [...new Set([...expected.keys(), ...actual.keys()])], deviated = codes.some((code) => Math.abs((expected.get(code) || 0) - (actual.get(code) || 0)) > 1e-4), reason = deviated ? required(b.deviationReason, "سبب اختلاف الاستهلاك الفعلي عن المقترح") : String(b.deviationReason || "").trim().slice(0, 160);
	const d = inv.state, outputLotId = "P-" + o.id + "-" + c.id;
	for (const { i, quantity } of rows) {
		const id = "USE-" + crypto.randomUUID(), common = {
			id,
			orderId: o.id,
			issueId: i.id,
			code: i.code,
			name: i.name,
			unit: i.unit,
			quantity,
			outputLotId,
			shiftId: c.shiftId,
			day: c.day,
			at: now,
			by: u.email,
			groupKey: fastKey(b),
			source: "confirmed-output-usage"
		};
		if (i.category === "packaging") {
			const m = inv.materials.find((m) => m.code === i.code);
			d.packs.push({
				...common,
				returnable: Boolean(m?.returnable),
				sourceBatch: i.batch,
				sourceLotId: i.lotId
			});
		} else {
			d.consumptions.push({
				...common,
				reason: reason || "استهلاك مؤكد مع الناتج " + c.id
			});
			controls(d).trace.push({
				id: "TRACE-" + crypto.randomUUID(),
				at: now,
				by: u.email,
				consumptionId: id,
				issueId: i.id,
				orderId: o.id,
				outputLotId,
				code: i.code,
				quantity
			});
		}
	}
	if (b.weights) {
		if (o.data.type !== "Filling" || c.unit !== "KG") throw Error("أوزان العبوات متاحة للمنتج المعبأ بالكيلوجرام");
		const count = Number(b.weights.count), gross = qty(b.weights.gross), tare = qty(b.weights.tare);
		if (!Number.isSafeInteger(count) || count <= 0 || count > 1e5 || round$1(gross - tare) !== c.quantity) throw Error("راجع عدد العبوات وأوزانها لتطابق كمية الناتج");
		o.data.weights ||= [];
		o.data.weights.push({
			id: "WT-" + (o.data.weights.length + 1),
			confirmationId: c.id,
			count,
			gross,
			tare,
			net: c.quantity,
			shiftId: c.shiftId,
			day: c.day,
			notes: String(b.notes || "").slice(0, 160),
			at: now,
			by: u.email
		});
	}
	c.usageSummary = {
		confirmed: true,
		by: u.email,
		at: now,
		deviated,
		reason,
		quantities: codes.map((code) => ({
			code,
			planned: expected.get(code) || 0,
			actual: actual.get(code) || 0
		}))
	};
	return {
		outputLotId,
		usageCount: rows.length
	};
}
async function commitOutputUsage(db, inv, o, b, u, now) {
	if (!db.batch) throw Error("التسجيل المجمع يحتاج تحديث خادم البرنامج");
	const c = o.data.confirmations[o.data.confirmations.length - 1], result = {
		ok: true,
		orderId: o.id,
		confirmationId: c.id,
		batch: c.batch,
		outputLotId: "P-" + o.id + "-" + c.id
	};
	o.data.lastFastOutputKey = fastKey(b);
	rememberFast(inv, b, u, result, now);
	tagNewMovements(inv.state, now);
	const orderSql = "UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND demo=? AND status='open' AND version=? AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=?";
	const orderArgs = [
		JSON.stringify(o.data),
		"open",
		o.id,
		o.demo,
		o.version,
		o.demo,
		inv.version
	];
	const guard = " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=? AND json_extract(data,'$.lastFastOutputKey')=?)", args = [
		o.id,
		o.demo,
		o.version + 1,
		fastKey(b)
	];
	const inventorySql = inv.version === 0 ? "INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1" + guard : "UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?" + guard;
	const inventoryArgs = inv.version === 0 ? [
		o.demo,
		JSON.stringify(inv.state),
		...args
	] : [
		JSON.stringify(inv.state),
		o.demo,
		inv.version,
		...args
	];
	const saved = await db.batch([{
		sql: orderSql,
		args: orderArgs
	}, {
		sql: inventorySql,
		args: inventoryArgs
	}]);
	if (saved.length !== 2 || saved.some((r) => r.changes !== 1)) {
		const prior = completedFast(await inventorySnapshot(db, o.demo), b, u);
		if (prior) return prior;
		throw Error("تغير الأمر أو المخزون؛ أعد مراجعة الناتج والاستهلاك");
	}
	return result;
}
//#endregion
//#region lib/auto-filling.ts
var jobs = (state) => state.automaticFillingJobs ||= [];
var serial = (prefix, rows) => prefix + "-" + String(rows.length + 1).padStart(7, "0");
function prepareAutomaticFilling(inv, parent, c, b, u, now) {
	if (b.autoFilling !== true) return null;
	if (parent.data.type !== "Bulk" || c.kind !== "main") throw Error("التعبئة التلقائية تبدأ من ناتج البلك الأساسي فقط");
	const early = jobs(inv.state).find((j) => j.planned && j.status === "waiting_quality" && j.parentOrderId === parent.id);
	const key = early?.key || "AF-" + parent.id + "-" + c.id;
	if (jobs(inv.state).some((j) => j.key === key && !j.planned)) throw Error("يوجد أمر تعبئة تلقائي لهذا الناتج بالفعل");
	const code = String(b.fillingCode || "").trim(), policy = b.fillingPolicy || "partial";
	if (!["partial", "full"].includes(policy)) throw Error("اختر سياسة العبوات");
	const configured = code ? automaticFillingPlan(inv.materials, parent.data.code, c.quantity, code, policy) : null;
	const job = {
		key,
		parentOrderId: parent.id,
		confirmationId: c.id,
		sourceLotId: "P-" + parent.id + "-" + c.id,
		bulkCode: parent.data.code,
		sourceQuantity: c.quantity,
		finishedCode: code,
		packingPolicy: policy,
		status: "waiting_quality",
		shortages: [],
		at: now,
		by: u.email,
		authorizationRole: actualRole(u),
		lineId: parent.data.lineId
	};
	if (early) jobs(inv.state).splice(jobs(inv.state).indexOf(early), 1, job);
	else jobs(inv.state).push(job);
	c.automaticFillingKey = key;
	c.plannedFillingCode = code;
	if (code) parent.data.automaticFillingDefaults = {
		code,
		policy
	};
	const clock = operatingShift(now);
	return {
		job,
		data: {
			cycleVersion: 4,
			type: "Filling",
			processType: "PI02",
			lineId: parent.data.lineId,
			costCentre: parent.data.costCentre || "",
			lineDailyRate: parent.data.lineDailyRate ?? 127,
			code: configured?.finished.code || "",
			name: configured?.finished.name || "أمر تعبئة تلقائي — بانتظار اعتماد البلك",
			unit: configured?.finished.unit || c.unit || "KG",
			target: configured?.target || c.quantity,
			warehouse: "FG",
			from: clock.day,
			to: clock.day,
			packingPolicy: policy,
			bom: configured?.plan || null,
			requirements: configured?.plan.inputs || [],
			sourceLotId: job.sourceLotId,
			sourceOriginLotId: job.sourceLotId,
			sourceOrderId: parent.id,
			sourceBatch: c.batch,
			sourceColor: "",
			sourceGrade: "",
			createdAt: now,
			createdBy: u.email,
			creationShift: shiftMetadata(now),
			automaticFilling: {
				key,
				sourceQuantity: c.quantity
			},
			notes: "أمر تعبئة مولد تلقائيًا من ناتج البلك",
			receipts: [],
			shifts: [],
			packaging: [],
			confirmations: [],
			waste: [],
			history: [{
				at: now,
				by: u.email,
				action: "إنشاء مسودة تعبئة تلقائية من البلك",
				...shiftMetadata(now)
			}]
		},
		reuse: Boolean(early)
	};
}
async function commitAutomaticOutput(db, inv, parent, draft, result, now, request, actor) {
	if (!db.batch) throw Error("التعبئة التلقائية تحتاج تحديث خادم البرنامج");
	const mutation = crypto.randomUUID(), key = draft.job.key;
	parent.data.lastAutomaticFillingMutation = mutation;
	const parentSql = "UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND demo=? AND version=? AND status='open' AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=? AND NOT EXISTS (SELECT 1 FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=? AND COALESCE(json_extract(data,'$.automaticFilling.planned'),0)=0)";
	const parentArgs = [
		JSON.stringify(parent.data),
		parent.status,
		parent.id,
		parent.demo,
		parent.version,
		parent.demo,
		inv.version,
		parent.demo,
		key
	];
	const guard = "EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=? AND json_extract(data,'$.lastAutomaticFillingMutation')=?)", args = [
		parent.id,
		parent.demo,
		parent.version + 1,
		mutation
	];
	const childSql = draft.reuse ? "UPDATE production_orders SET data=json_set(?,'$.serial',json_extract(data,'$.serial'),'$.number',json_extract(data,'$.number')),version=version+1 WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=? AND json_extract(data,'$.automaticFilling.planned')=1 AND " + guard : "INSERT INTO production_orders(demo,version,status,data) SELECT ?,1,'open',json_set(?,'$.serial',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1,'$.number','FO-' || printf('%07d',COALESCE(MAX(CAST(json_extract(data,'$.serial') AS INTEGER)),0)+1)) FROM production_orders WHERE json_extract(data,'$.type')='Filling' HAVING " + guard + " AND NOT EXISTS (SELECT 1 FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=? AND COALESCE(json_extract(data,'$.automaticFilling.planned'),0)=0)";
	const childArgs = draft.reuse ? [
		JSON.stringify(draft.data),
		parent.demo,
		key,
		...args
	] : [
		parent.demo,
		JSON.stringify(draft.data),
		...args,
		parent.demo,
		key
	];
	const childGuard = guard + " AND EXISTS (SELECT 1 FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=?)", allArgs = [
		...args,
		parent.demo,
		key
	];
	const inventorySql = inv.version === 0 ? "INSERT INTO inventory(id,version,data) SELECT ?,1,? WHERE " + childGuard + " ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=inventory.version+1 WHERE inventory.version=0" : "UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=? AND " + childGuard;
	const inventoryArgs = inv.version === 0 ? [
		parent.demo,
		JSON.stringify(inv.state),
		...allArgs
	] : [
		JSON.stringify(inv.state),
		parent.demo,
		inv.version,
		...allArgs
	];
	const saved = await db.batch([
		{
			sql: parentSql,
			args: parentArgs
		},
		{
			sql: childSql,
			args: childArgs
		},
		{
			sql: inventorySql,
			args: inventoryArgs
		}
	]);
	if (saved.length !== 3 || saved.some((r) => r.changes !== 1)) {
		const current = await inventorySnapshot(db, parent.demo), prior = result.operationKey ? completedFast(current, request, actor) : null;
		if (prior) return prior;
		throw Error("تغير الأمر أو المخزون؛ أعد مراجعة الناتج والتعبئة");
	}
	const child = await db.first("SELECT id,data FROM production_orders WHERE demo=? AND json_extract(data,'$.automaticFilling.key')=?", [parent.demo, key]);
	return {
		...result,
		fillingOrderId: child?.id,
		fillingOrderNumber: child ? JSON.parse(child.data).number : "",
		automaticFillingKey: key
	};
}
async function saveJob(db, inv, child, parent, now) {
	if (!db.batch) throw Error("التعبئة التلقائية تحتاج تحديث خادم البرنامج");
	const mutation = crypto.randomUUID();
	child.data.lastAutomaticFillingMutation = mutation;
	const sql = "UPDATE production_orders SET data=?,status=?,version=version+1 WHERE id=? AND demo=? AND version=? AND status='open' AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=? AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=?)";
	const args = [
		JSON.stringify(child.data),
		child.status,
		child.id,
		child.demo,
		child.version,
		child.demo,
		inv.version,
		parent.id,
		child.demo,
		parent.version
	];
	const guard = "EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=? AND json_extract(data,'$.lastAutomaticFillingMutation')=?)", g = [
		child.id,
		child.demo,
		child.version + 1,
		mutation
	];
	const update = "UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=? AND " + guard;
	const saved = await db.batch([{
		sql,
		args
	}, {
		sql: update,
		args: [
			JSON.stringify(inv.state),
			child.demo,
			inv.version,
			...g
		]
	}]);
	return saved.length === 2 && saved.every((r) => r.changes === 1);
}
function clearEarlyPacking(state, key, now, by) {
	for (const r of state.reservations) if (r.earlyPackingKey === key) r.remaining = 0;
	for (const t of state.transfers) if (t.earlyPackingKey === key && !t.receivedAt && !t.cancelledAt) Object.assign(t, {
		cancelledAt: now,
		cancelledBy: by,
		cancelReason: "تسوية تجهيز التعبئة المبكر"
	});
}
function setJob(job, status, detail = "", shortages = []) {
	Object.assign(job, {
		status,
		detail,
		shortages
	});
}
function planAllocations(inv, child, source) {
	const lines = [], shortages = [], own = (lotId) => inv.state.reservations.filter((r) => r.orderId === child.id && r.lotId === lotId && r.remaining > 0).reduce((n, r) => n + r.remaining, 0);
	const all = inv.lots.filter((l) => l.quality === "A" && !l.warehousePending && !l.expired), available = new Map(all.map((l) => [l.id, round$1(l.available + own(l.id) + inv.state.transfers.filter((t) => t.earlyPackingKey === child.data.automaticFilling.key && t.sourceLotId === l.id && !t.receivedAt && !t.cancelledAt).reduce((n, t) => n + t.quantity, 0))]));
	for (const need of child.data.requirements) {
		let left = need.quantity;
		const semi = inv.materials.find((m) => m.code === need.code)?.category === "semi";
		const choices = all.filter((l) => l.code === need.code && l.unit === need.unit && (semi ? l.id === source.id || (l.originLotId || l.id) === source.id : ["PROD", "PACK"].includes(l.warehouse))).sort((a, b) => (a.warehouse === "PROD" ? 0 : 1) - (b.warehouse === "PROD" ? 0 : 1) || String(a.expiryDate || "9999").localeCompare(String(b.expiryDate || "9999")) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
		for (const lot of choices) {
			let quantity = round$1(Math.min(left, available.get(lot.id) || 0));
			if (lot.unit === "PC") quantity = Math.floor(quantity);
			if (quantity <= 0) continue;
			lines.push({
				lot,
				quantity
			});
			available.set(lot.id, round$1((available.get(lot.id) || 0) - quantity));
			left = round$1(left - quantity);
			if (!left) break;
		}
		if (left > 0) shortages.push({
			code: need.code,
			name: need.name,
			unit: need.unit,
			quantity: left
		});
	}
	return {
		lines,
		shortages
	};
}
async function runAutomaticFilling(db, demo, key, trigger) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const inv = await inventorySnapshot(db, demo), job = jobs(inv.state).find((j) => j.key === key);
		if (!job || job.planned || [
			"completed",
			"cancelled",
			"rejected",
			"manual"
		].includes(job.status)) return job || null;
		const child = inv.orders.find((o) => o.data.automaticFilling?.key === key), parent = inv.orders.find((o) => o.id === job.parentOrderId), source = inv.lots.find((l) => l.id === job.sourceLotId);
		if (!child || !parent || !source) return job;
		if (child.status !== "open") return {
			...job,
			status: "blocked",
			detail: "أمر التعبئة مغلق"
		};
		const now = (/* @__PURE__ */ new Date()).toISOString(), before = JSON.stringify({
			job,
			data: child.data
		}), state = inv.state;
		let execute = false, mutationStarted = false;
		if (source.quality === "R") {
			clearEarlyPacking(state, key, now, trigger.email);
			setJob(job, "rejected");
			child.status = "closed";
			child.data.cancelledAt = now;
			child.data.cancelReason = "رفض البلك المصدر بواسطة الجودة";
		} else if (source.quality !== "A" || !source.color || !source.grade) setJob(job, "waiting_quality");
		else {
			const options = automaticFillingCandidates(inv.materials, job.bulkCode).filter((m) => Array.isArray(source.allowedFinishedCodes) && source.allowedFinishedCodes.includes(m.code));
			let code = job.finishedCode;
			const selected = parent.data.confirmations.find((c) => c.id === job.confirmationId)?.selectedFillingCode;
			if (!job.qualitySelectionApplied && selected) {
				code = selected;
				job.qualitySelectionApplied = true;
			}
			if (!options.some((m) => m.code === code)) code = options.length === 1 ? options[0].code : "";
			if (!code) setJob(job, "choose_product");
			else if (state.issues.some((i) => i.orderId === child.id) || state.preparations.some((p) => p.orderId === child.id && p.quantity > p.cancelled) || (child.data.confirmations || []).length > 0 || (child.data.requirementChanges || []).length || child.data.requirements.some((r) => r.source !== "BOM")) setJob(job, "manual_review");
			else try {
				const planned = automaticFillingPlan(inv.materials, job.bulkCode, job.sourceQuantity, code, job.packingPolicy);
				if (job.finishedCode && job.finishedCode !== code) clearEarlyPacking(state, key, now, trigger.email);
				job.finishedCode = code;
				child.data = {
					...child.data,
					code,
					name: planned.finished.name,
					unit: planned.finished.unit,
					target: planned.target,
					bom: planned.plan,
					requirements: planned.plan.inputs,
					sourceColor: source.color,
					sourceGrade: source.grade
				};
				if (source.warehousePending) setJob(job, "waiting_warehouse");
				else {
					assertDayOpen(inv, operatingShift(now).day);
					assertUsable(source, dateInCairo(now));
					assertLineReady(inv, child);
					assertScope(inv, {
						email: job.by,
						role: job.authorizationRole
					}, {
						lineId: child.data.lineId,
						warehouse: "PROD"
					});
					if (!isReleased(inv, parent)) throw Error("أمر البلك المصدر غير معتمد للتنفيذ");
					if ((child.data.requirementChanges || []).length || child.data.requirements.some((r) => r.source !== "BOM")) throw Error("توجد تعديلات على مخطط الصرف تحتاج مراجعة");
					const allocation = planAllocations(inv, child, source);
					if (allocation.shortages.length) setJob(job, "shortage", "", allocation.shortages);
					else {
						for (const { lot } of allocation.lines) assertScope(inv, {
							email: job.by,
							role: job.authorizationRole
						}, { warehouse: lot.warehouse });
						const clock = operatingShift(now);
						if (child.data.shifts.some((s) => s.id === clock.id && s.closedAt)) throw Error("الشيفت الحالي مغلق على أمر التعبئة");
						mutationStarted = true;
						child.data.from = clock.day;
						child.data.to = clock.day;
						ensureAutoShift(inv, child, {
							email: job.by,
							role: job.authorizationRole
						}, now);
						const control = controls(state);
						if (!isReleased(inv, child)) control.releases.push({
							id: "AF-REL-" + crypto.randomUUID(),
							orderId: child.id,
							decision: "A",
							automaticFillingKey: key,
							sourceOrderId: parent.id,
							sourceConfirmationId: job.confirmationId,
							by: job.by,
							at: now,
							executedBy: trigger.email,
							reason: "إطلاق تلقائي مشتق من أمر البلك المعتمد",
							...shiftMetadata(now)
						});
						for (const line of allocation.lines) {
							let lot = line.lot;
							assertUsable(lot, dateInCairo(now));
							let left = line.quantity;
							for (const r of state.reservations.filter((r) => r.orderId === child.id && r.lotId === lot.id && r.remaining > 0)) {
								const take = Math.min(left, r.remaining);
								r.remaining = round$1(r.remaining - take);
								left = round$1(left - take);
								if (!left) break;
							}
							if (lot.category === "semi" && lot.warehouse !== "PROD") {
								const id = "AFTR-" + crypto.randomUUID(), number = serial("TR", state.transfers), material = {
									code: lot.code,
									name: lot.name,
									category: lot.category,
									unit: lot.unit,
									batch: lot.batch,
									quality: lot.quality,
									color: lot.color,
									grade: lot.grade,
									allowedFinishedCodes: lot.allowedFinishedCodes,
									expiryDate: lot.expiryDate,
									orderId: parent.id
								};
								state.transfers.push({
									id,
									number,
									sourceLotId: lot.id,
									originLotId: source.id,
									material,
									code: lot.code,
									name: lot.name,
									unit: lot.unit,
									batch: lot.batch,
									quantity: line.quantity,
									fromWarehouse: lot.warehouse,
									toWarehouse: "PROD",
									at: now,
									by: job.by,
									receivedAt: now,
									receivedBy: job.by,
									executedBy: trigger.email,
									automaticFillingKey: key,
									reason: "تحويل البلك المعتمد للتعبئة التلقائية",
									...shiftMetadata(now)
								});
								lot = {
									...lot,
									id: "TR-" + id,
									warehouse: "PROD",
									originLotId: source.id
								};
							}
							state.issues.push({
								id: "AFI-" + crypto.randomUUID(),
								number: serial("GI", state.issues),
								orderId: child.id,
								lotId: lot.id,
								code: lot.code,
								name: lot.name,
								category: lot.category,
								unit: lot.unit,
								warehouse: lot.warehouse,
								batch: lot.batch,
								quantity: line.quantity,
								at: now,
								by: job.by,
								acceptedAt: now,
								acceptedBy: job.by,
								executedBy: trigger.email,
								...shiftMetadata(now),
								automaticFillingKey: key,
								sourceOrderId: lot.category === "semi" ? parent.id : lot.orderId || null,
								sourceReference: lot.category === "semi" ? source.source : lot.source,
								notes: "صرف تلقائي حسب مخطط التعبئة"
							});
						}
						clearEarlyPacking(state, key, now, trigger.email);
						delete job.lastError;
						setJob(job, "completed");
						job.executedAt = now;
						job.executedBy = trigger.email;
						job.issueNumbers = state.issues.filter((i) => i.automaticFillingKey === key).map((i) => i.number);
						execute = true;
					}
				}
			} catch (error) {
				if (mutationStarted) throw error;
				setJob(job, "blocked", error.message);
			}
		}
		if (before === JSON.stringify({
			job,
			data: child.data
		})) return job;
		job.updatedAt = now;
		job.updatedBy = trigger.email;
		child.data.history.push({
			at: now,
			by: trigger.email,
			action: execute ? "الصرف التلقائي لمواد أمر التعبئة" : "تحديث حالة التعبئة التلقائية",
			automaticFillingKey: key,
			status: job.status,
			...shiftMetadata(now)
		});
		state.history.push({
			id: "AFH-" + crypto.randomUUID(),
			at: now,
			by: trigger.email,
			action: execute ? "الصرف التلقائي لمواد أمر التعبئة" : "تحديث حالة التعبئة التلقائية",
			orderId: child.id,
			automaticFillingKey: key,
			status: job.status,
			...shiftMetadata(now)
		});
		if (await saveJob(db, inv, child, parent, now)) return {
			...job,
			orderId: child.id,
			orderNumber: child.number
		};
	}
	throw Error("تعارض تحديث التعبئة التلقائية؛ أعد المحاولة");
}
async function processAutomaticFilling(db, trigger, demo, event = {}) {
	const inv = await inventorySnapshot(db, demo), queue = jobs(inv.state).filter((j) => ![
		"completed",
		"cancelled",
		"rejected",
		"manual"
	].includes(j.status) && (!event.parentOrderId || j.parentOrderId === event.parentOrderId) && (!event.sourceLotId || j.sourceLotId === event.sourceLotId) && (!event.key || j.key === event.key));
	const results = [];
	for (const job of queue) {
		const parent = inv.orders.find((o) => o.id === job.parentOrderId);
		if (parent) try {
			assertScope(inv, trigger, { lineId: parent.data.lineId });
		} catch {
			continue;
		}
		try {
			results.push(await runAutomaticFilling(db, demo, job.key, trigger));
		} catch {
			const message = "تعذر إكمال المحاولة؛ حدّث البيانات ثم أعد المحاولة";
			const fresh = await inventorySnapshot(db, demo), current = jobs(fresh.state).find((j) => j.key === job.key), child = fresh.orders.find((o) => o.data.automaticFilling?.key === job.key), parent = fresh.orders.find((o) => o.id === job.parentOrderId);
			if (current && child && parent && ![
				"completed",
				"cancelled",
				"rejected",
				"manual"
			].includes(current.status)) {
				current.lastError = message;
				current.lastAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
				current.failedAttempts = (current.failedAttempts || 0) + 1;
				try {
					await saveJob(db, fresh, child, parent, current.lastAttemptAt);
				} catch {}
			}
			results.push({
				key: job.key,
				status: "blocked",
				detail: message
			});
		}
	}
	return results;
}
async function safeAutomaticFilling(db, trigger, demo, event = {}) {
	try {
		return { automaticFilling: await processAutomaticFilling(db, trigger, demo, event) };
	} catch {
		return { automaticFillingPending: true };
	}
}
async function automaticFillingOperation(db, u, b) {
	if (!(b.action === "auto_filling_manual" ? ["admin", "plant_manager"] : ["admin", "production"]).includes(actualRole(u))) throw Error("متابعة وتعديل التعبئة التلقائية من صلاحية الإنتاج");
	const demo = b.demo === true ? 1 : 0, inv = await inventorySnapshot(db, demo), child = inv.orders.find((o) => o.id === b.orderId), job = jobs(inv.state).find((j) => j.key === child?.data.automaticFilling?.key);
	if (!child || child.status !== "open" || !job) throw Error("أمر التعبئة التلقائي غير متاح");
	assertScope(inv, u, { lineId: child.data.lineId });
	if (b.inventoryVersion !== inv.version || b.version !== child.version) throw Error("تغير الأمر أو المخزون؛ حدّث البيانات");
	if (b.action === "auto_filling_manual") {
		if (job.status !== "manual_review") throw Error("التحويل اليدوي متاح للأوامر التي تتطلب مراجعة يدوية فقط");
		assertApprover(u, job.by, demo);
		const source = inv.lots.find((l) => l.id === job.sourceLotId);
		if (!source || source.quality !== "A" || source.warehousePending) throw Error("استكمل اعتماد جودة البلك أولًا");
		if (!child.data.code || !source.allowedFinishedCodes?.includes(child.data.code)) throw Error("اختر منتجًا اعتمدته جودة البلك");
		const now = (/* @__PURE__ */ new Date()).toISOString(), reason = required(b.reason, "سبب التحويل للتنفيذ اليدوي"), parent = inv.orders.find((o) => o.id === job.parentOrderId);
		assertDayOpen(inv, operatingShift(now).day);
		child.data.automaticFillingManual = {
			...child.data.automaticFilling,
			at: now,
			by: u.email,
			reason
		};
		delete child.data.automaticFilling;
		setJob(job, "manual", reason);
		job.updatedAt = now;
		job.updatedBy = u.email;
		child.data.history.push({
			at: now,
			by: u.email,
			action: "تحويل التعبئة للتنفيذ اليدوي",
			reason
		});
		if (!parent || !await saveJob(db, inv, child, parent, now)) throw Error("تعارض تحديث الأمر؛ حدّث الصفحة");
		return { ok: true };
	}
	if (b.action === "auto_filling_cancel") {
		if (job.status === "completed" || inv.state.issues.some((i) => i.orderId === child.id) || inv.state.reservations.some((r) => r.orderId === child.id && r.remaining > 0 && r.earlyPackingKey !== job.key) || inv.state.preparations.some((p) => p.orderId === child.id && p.quantity > p.cancelled)) throw Error("لا يمكن إلغاء المسودة بعد بدء صرف المواد أو حجزها");
		const now = (/* @__PURE__ */ new Date()).toISOString(), parent = inv.orders.find((o) => o.id === job.parentOrderId), reason = required(b.reason, "سبب إلغاء مسودة التعبئة");
		clearEarlyPacking(inv.state, job.key, now, u.email);
		setJob(job, "cancelled", reason);
		job.updatedAt = now;
		job.updatedBy = u.email;
		child.status = "closed";
		child.data.cancelledAt = now;
		child.data.cancelReason = reason;
		child.data.history.push({
			at: now,
			by: u.email,
			action: "إلغاء مسودة التعبئة التلقائية",
			reason,
			...shiftMetadata(now)
		});
		inv.state.history.push({
			at: now,
			by: u.email,
			action: "إلغاء مسودة التعبئة التلقائية",
			orderId: child.id,
			reason,
			...shiftMetadata(now)
		});
		if (!parent || !await saveJob(db, inv, child, parent, now)) throw Error("تعارض تحديث التعبئة التلقائية؛ أعد المحاولة");
		return {
			ok: true,
			automaticFilling: [job]
		};
	}
	if (b.action === "auto_filling_choose") {
		if (job.status === "completed" || inv.state.issues.some((i) => i.orderId === child.id) || inv.state.reservations.some((r) => r.orderId === child.id && r.remaining > 0 && r.earlyPackingKey !== job.key) || inv.state.preparations.some((p) => p.orderId === child.id && p.quantity > p.cancelled)) throw Error("لا يمكن تغيير المنتج بعد بدء صرف المواد أو حجزها");
		const source = inv.lots.find((l) => l.id === job.sourceLotId), code = required(b.code, "المنتج المعبأ المعتمد");
		if (!source || source.quality !== "A" || !source.allowedFinishedCodes?.includes(code)) throw Error("اختر منتجًا معبأ اعتمدته جودة هذا البلك");
		automaticFillingPlan(inv.materials, job.bulkCode, job.sourceQuantity, code, job.packingPolicy);
		job.finishedCode = code;
		const parent = inv.orders.find((o) => o.id === job.parentOrderId);
		job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		job.updatedBy = u.email;
		inv.state.history.push({
			at: job.updatedAt,
			by: u.email,
			action: "تحديد منتج التعبئة التلقائية",
			orderId: child.id,
			code,
			...shiftMetadata(job.updatedAt)
		});
		if (!parent || !await saveJob(db, inv, child, parent, job.updatedAt)) throw Error("تعارض تحديث التعبئة التلقائية؛ أعد المحاولة");
	} else if (b.action !== "auto_filling_retry") throw Error("إجراء تعبئة تلقائية غير معروف");
	return {
		ok: true,
		automaticFilling: await processAutomaticFilling(db, u, demo, { key: job.key })
	};
}
//#endregion
//#region lib/fruit-completion.ts
var replay = (row, u, b) => {
	if (!row || row.status !== "done" || row.version !== b.version + 1) return null;
	const data = JSON.parse(row.data), receipt = data.fruitReceipt;
	return receipt?.schemaVersion === 7 && receipt.postedBy === u.email && Number(b.empty) === data.empty ? {
		ok: true,
		replayed: true,
		receipt
	} : null;
};
async function completeFruitReceipt(db, u, b) {
	if (!["admin", "scale"].includes(u.role)) throw Error("لا توجد صلاحية لتسجيل الوزن الفارغ");
	if (!Number.isSafeInteger(b.id) || !Number.isSafeInteger(b.version)) throw Error("رقم تذكرة غير صالح");
	const row = await db.first("SELECT * FROM tickets WHERE id=?", [b.id]);
	const prior = replay(row, u, b);
	if (prior) return prior;
	if (!row || row.version !== b.version) throw Error("تم تحديث التذكرة؛ أعد فتحها");
	const now = (/* @__PURE__ */ new Date()).toISOString(), original = JSON.parse(row.data), d = transition({
		...row,
		data: original
	}, "empty", b, u.role, now).data;
	if (Math.abs(round$1(d.net) - d.net) > 1e-6) throw Error("الأوزان تسجل بحد أقصى 3 أرقام عشرية");
	if (d.decision !== "A") throw Error("يجب اعتماد قبول الجودة قبل إتمام استلام الثمار");
	if (!db.batch) throw Error("تسجيل استلام الثمار يحتاج تحديث خادم البرنامج");
	const inv = await inventorySnapshot(db, row.demo), state = inv.state, clock = operatingShift(now), lotId = "T-" + row.id;
	assertDayOpen(inv, clock.day);
	const legacy = Boolean(d.productionOrderId || inv.orders.some((o) => (o.data.receipts || []).some((r) => r.ticketId === row.id)) || state.issues.some((i) => i.lotId === lotId) || state.warehouseReceipts.some((r) => r.lotId === lotId) || state.transfers.some((t) => t.sourceLotId === lotId) || state.preparations.some((p) => p.lotId === lotId) || state.reservations.some((r) => r.lotId === lotId) || state.adjustments.some((r) => r.lotId === lotId));
	let order = null, issue = null, reason = "no-order", issued = 0;
	if (!legacy) {
		state.fruitLocations ||= {};
		state.fruitLocations[lotId] = "PROD";
		const selected = inv.orders.find((o) => o.id === d.receivingOrderId);
		if (d.receivingOrderId) {
			reason = "order-unavailable";
			if (selected && selected.status === "open" && ["Bulk", "PI01"].includes(selected.data.type)) {
				reason = "outside-period";
				if (selected.data.from <= clock.day && selected.data.to >= clock.day) {
					reason = "order-not-released";
					if (isReleased(inv, selected)) {
						const requirement = (selected.data.requirements || []).find((r) => r.code === d.fruitCode && r.unit === "KG");
						reason = "no-remaining-need";
						if (requirement) {
							const pending = state.preparations.filter((p) => p.orderId === selected.id && p.code === d.fruitCode).reduce((n, p) => n + Math.max(0, p.quantity - p.received - p.cancelled), 0);
							const reserved = state.reservations.filter((r) => r.orderId === selected.id && r.code === d.fruitCode).reduce((n, r) => n + r.remaining, 0);
							const remaining = round$1(Math.max(0, remainingRequirement(inv, selected, d.fruitCode) - pending - reserved));
							const closed = selected.data.shifts.some((s) => s.id === clock.id && s.closedAt);
							reason = closed ? "shift-closed" : "no-remaining-need";
							if (!closed && remaining > 0) {
								issued = round$1(Math.min(d.net, remaining));
								if (issued > 0) {
									order = selected;
									const shift = ensureAutoShift(inv, order, u, now), acceptedBy = d.unloadBy || u.email;
									issue = {
										id: "FRI-" + crypto.randomUUID(),
										number: "GI-" + String(state.issues.length + 1).padStart(7, "0"),
										orderId: order.id,
										lotId,
										code: d.fruitCode,
										name: d.fruit,
										category: "raw",
										unit: "KG",
										warehouse: "PROD",
										batch: "B-" + String(row.id).padStart(7, "0"),
										quantity: issued,
										at: now,
										by: acceptedBy,
										postedBy: u.email,
										acceptedAt: now,
										acceptedBy,
										...shiftMetadata(now),
										shiftId: shift.id,
										directFruit: true,
										automaticFruitReceipt: true,
										ticketId: row.id,
										sourceReference: "FR-" + String(row.id).padStart(7, "0"),
										notes: "صرف الثمار مباشرة عند اكتمال الوزن الفارغ"
									};
									state.issues.push(issue);
									reason = issued < d.net ? "partial" : "allocated";
								}
							}
						}
					}
				}
			}
		}
	} else reason = "historical";
	const receipt = {
		schemaVersion: 7,
		postingKey: crypto.randomUUID(),
		warehouse: legacy ? "historical" : "PROD",
		lotId,
		requestedOrderId: d.receivingOrderId || null,
		requestedOrderNumber: d.order || "",
		receivedQuantity: d.net,
		issuedQuantity: issued,
		unallocatedQuantity: legacy ? null : round$1(d.net - issued),
		orderId: order?.id || null,
		orderNumber: order?.number || "",
		issueId: issue?.id || null,
		issueNumber: issue?.number || "",
		status: legacy ? "historical" : issued === d.net ? "allocated" : issued > 0 ? "partial" : "stock",
		reason,
		at: now,
		postedBy: u.email,
		...shiftMetadata(now)
	};
	d.fruitReceipt = receipt;
	d.emptyBy = u.email;
	if (!legacy) {
		d.requiresWarehouseReceipt = false;
		d.receivingRoute = "direct-production-v47";
	}
	const action = issued > 0 ? "استلام ثمار بمخزن الإنتاج وصرف مباشر على الأمر" : "استلام ثمار مباشرة بمخزن الإنتاج";
	const history = [...JSON.parse(row.history), {
		at: now,
		by: u.email,
		action,
		...shiftMetadata(now),
		receipt
	}];
	state.history.push({
		id: "FR-" + receipt.postingKey,
		at: now,
		by: u.email,
		action,
		reference: lotId,
		orderId: order?.id || null,
		...shiftMetadata(now)
	});
	const orderGuard = order ? " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND status='open' AND version=?)" : "", orderArgs = order ? [
		order.id,
		row.demo,
		order.version
	] : [];
	const ticketSql = "UPDATE tickets SET data=?,history=?,status='done',version=version+1 WHERE id=? AND demo=? AND version=? AND status IN ('empty','assign') AND COALESCE((SELECT version FROM inventory WHERE id=?),0)=?" + orderGuard;
	const ticketArgs = [
		JSON.stringify(d),
		JSON.stringify(history),
		row.id,
		row.demo,
		row.version,
		row.demo,
		inv.version,
		...orderArgs
	];
	const guard = "EXISTS (SELECT 1 FROM tickets WHERE id=? AND demo=? AND version=? AND json_extract(data,'$.fruitReceipt.postingKey')=?)", args = [
		row.id,
		row.demo,
		row.version + 1,
		receipt.postingKey
	];
	const inventorySql = inv.version === 0 ? "INSERT INTO inventory(id,version,data) SELECT ?,1,? WHERE " + guard + " ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=inventory.version+1 WHERE inventory.version=0" : "UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=? AND " + guard;
	const inventoryArgs = inv.version === 0 ? [
		row.demo,
		JSON.stringify(state),
		...args
	] : [
		JSON.stringify(state),
		row.demo,
		inv.version,
		...args
	];
	const saved = await db.batch([{
		sql: ticketSql,
		args: ticketArgs
	}, {
		sql: inventorySql,
		args: inventoryArgs
	}]);
	if (saved.length !== 2 || saved.some((r) => r.changes !== 1)) {
		const repeated = replay(await db.first("SELECT * FROM tickets WHERE id=?", [row.id]), u, b);
		if (repeated) return repeated;
		throw Error("تغيرت التذكرة أو الأرصدة أو الأمر؛ أعد فتح التذكرة");
	}
	return {
		ok: true,
		receipt
	};
}
//#endregion
//#region lib/operations-control.ts
var day = (v) => {
	const s = required(v, "التاريخ");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw Error("تاريخ غير صحيح");
	return s;
};
var optional = (v) => String(v || "").trim().slice(0, 160);
var stamp = (v) => {
	const s = required(v, "وقت الحركة");
	if (!Number.isFinite(Date.parse(s)) || Date.parse(s) > Date.now()) throw Error("وقت الحركة غير صحيح أو مستقبلي");
	return new Date(s).toISOString();
};
async function controlOperation(db, u, b) {
	const demo = b.demo === true ? 1 : 0, inv = await inventorySnapshot(db, demo), d = inv.state, c = controls(d), role = actualRole(u), op = b.action, now = (/* @__PURE__ */ new Date()).toISOString(), id = crypto.randomUUID();
	if (b.inventoryVersion !== inv.version) throw Error("الأرصدة أو الاعتمادات تغيرت؛ حدّث الصفحة");
	const allowed = (kind) => {
		if (!canControl(role, kind)) throw Error("لا توجد صلاحية لهذا الإجراء");
	};
	const order = (oid) => {
		const o = inv.orders.find((o) => o.id === Number(oid));
		if (!o) throw Error("الأمر غير موجود");
		assertScope(inv, u, { lineId: o.data.lineId });
		return o;
	};
	const lot = (lid) => {
		const l = inv.lots.find((l) => l.id === lid);
		if (!l) throw Error("الباتش غير موجود");
		assertWarehouse(u, l.warehouse);
		assertScope(inv, u, { warehouse: l.warehouse });
		if (l.orderId) {
			const source = inv.orders.find((o) => o.id === l.orderId);
			if (source) assertScope(inv, u, { lineId: source.data.lineId });
		}
		return l;
	};
	const base = {
		id,
		at: now,
		by: u.email,
		...shiftMetadata(now)
	};
	let action = "", guardOrder = null;
	const request = (kind, data) => {
		const r = {
			...base,
			number: "AP-" + String(c.requests.length + 1).padStart(7, "0"),
			kind,
			status: "pending",
			reason: required(b.reason, "سبب الطلب"),
			...data
		};
		c.requests.push(r);
		return r;
	};
	const allocate = (o) => {
		for (const need of o.data.requirements) {
			const existing = d.reservations.filter((r) => r.orderId === o.id && r.code === need.code).reduce((n, r) => n + r.remaining, 0), issued = d.issues.filter((i) => i.orderId === o.id && i.code === need.code).reduce((n, i) => n + i.quantity - d.returns.filter((r) => r.issueId === i.id).reduce((n, r) => n + r.quantity, 0), 0), prepared = d.preparations.filter((p) => p.orderId === o.id && p.code === need.code).reduce((n, p) => n + p.quantity - p.received - p.cancelled, 0);
			let left = round$1(Math.max(0, need.quantity - existing - issued - prepared));
			const options = inv.lots.filter((l) => l.code === need.code && l.quality === "A" && !l.warehousePending && !expired(l, dateInCairo(now)) && (o.data.type === "Filling" && l.category === "semi" ? (l.originLotId || l.id) === o.data.sourceOriginLotId : l.warehouse === "PROD")).sort((a, b) => String(a.expiryDate || "9999").localeCompare(String(b.expiryDate || "9999")) || String(a.at).localeCompare(String(b.at)));
			for (const l of options) {
				const amount = round$1(Math.min(left, l.available));
				if (amount <= 0) continue;
				assertWarehouse(u, l.warehouse);
				assertScope(inv, u, { warehouse: l.warehouse });
				d.reservations.push({
					id: "RES-" + crypto.randomUUID(),
					orderId: o.id,
					lotId: l.id,
					code: l.code,
					quantity: amount,
					remaining: amount,
					by: u.email,
					at: now,
					approval: true
				});
				l.available = round$1(l.available - amount);
				left = round$1(left - amount);
				if (!left) break;
			}
			if (left > 0 && o.data.type === "Filling" && inv.materials.find((m) => m.code === need.code)?.category === "semi") throw Error("رصيد البلك لا يكفي لحجز أمر التعبئة؛ راجع الأوامر المعتمدة");
		}
	};
	if (op === "control_order_submit") {
		allowed("plan");
		const o = order(b.orderId);
		if (o.data.automaticFilling) throw Error("إطلاق أمر التعبئة التلقائي يتم بعد اكتمال الجودة والمواد");
		if (o.status !== "open" || o.data.cycleVersion < 4 || isReleased(inv, o)) throw Error("الأمر غير متاح لطلب الإطلاق");
		if (c.requests.some((r) => r.kind === "release" && r.orderId === o.id && r.status === "pending")) throw Error("يوجد طلب اعتماد معلق");
		request("release", {
			orderId: o.id,
			orderVersion: o.version
		});
		guardOrder = o;
		action = "طلب اعتماد إطلاق الأمر";
	} else if (op === "control_allocate") {
		allowed("plan");
		const o = order(b.orderId);
		if (o.status !== "open" || !isReleased(inv, o)) throw Error("اعتمد إطلاق الأمر أولًا");
		allocate(o);
		guardOrder = o;
		action = "استكمال حجز احتياجات الأمر";
	} else if (op === "control_adjust_request") {
		allowed("adjust");
		const l = lot(b.lotId);
		assertWarehouse(u, l.warehouse);
		const count = Number(b.count);
		if (b.count == null || b.count === "" || !Number.isFinite(count) || count < 0 || count > 1e9 || l.unit === "PC" && !Number.isInteger(count) || Math.abs(count * 1e3 - Math.round(count * 1e3)) > 1e-5) throw Error("كمية الجرد غير صحيحة");
		request("count", {
			lotId: l.id,
			code: l.code,
			warehouse: l.warehouse,
			expectedBalance: l.balance,
			count
		});
		action = "طلب اعتماد فرق جرد";
	} else if (op === "control_reverse_request") {
		allowed("adjust");
		if (![
			"issue",
			"transfer",
			"adjustment",
			"pack",
			"consumption"
		].includes(b.kind)) throw Error("اختر نوع الحركة للتصحيح");
		request("reverse", {
			sourceType: b.kind,
			sourceId: required(b.sourceId, "رقم الحركة")
		});
		action = "طلب مستند عكسي";
	} else if (op === "control_request_cancel") {
		const r = c.requests.find((r) => r.id === b.requestId && r.status === "pending");
		if (!r || u.email !== r.by && role !== "admin") throw Error("طلب الاعتماد غير متاح");
		r.status = "cancelled";
		r.cancelledAt = now;
		r.cancelledBy = u.email;
		action = "إلغاء طلب اعتماد";
	} else if (op === "control_decide") {
		const r = c.requests.find((r) => r.id === b.requestId && r.status === "pending");
		if (!r) throw Error("طلب الاعتماد غير متاح");
		assertApprover(u, r.by, demo);
		if (!["A", "R"].includes(b.decision)) throw Error("اختر قبول أو رفض");
		const reason = required(b.reason, "سبب قرار الاعتماد");
		if (b.decision === "A") {
			assertDayOpen(inv, operatingShift(now).day);
			if (r.kind === "release") {
				const o = order(r.orderId);
				if (o.status !== "open" || o.version !== r.orderVersion || isReleased(inv, o)) throw Error("الأمر تغير؛ أعد تقديم الطلب");
				if (!o.data.requirements.length) throw Error("أضف احتياجات الأمر قبل الاعتماد");
				if (!c.machines.find((m) => m.id === o.data.lineId && m.kind === "line")) throw Error("حدد خط الإنتاج قبل الاعتماد");
				c.releases.push({
					...base,
					orderId: o.id,
					decision: "A",
					requestId: r.id,
					orderVersion: o.version
				});
				allocate(o);
				guardOrder = o;
			} else if (r.kind === "count") {
				const l = lot(r.lotId);
				if (l.balance !== r.expectedBalance) throw Error("تغير الرصيد بعد الجرد؛ أعد الجرد والتقديم");
				const delta = round$1(r.count - l.balance);
				if (delta < 0 && -delta > l.available) throw Error("فرق الجرد يتعارض مع كميات محجوزة أو مستخدمة");
				if (delta) d.adjustments.push({
					...base,
					lotId: l.id,
					quantity: delta,
					reason: r.reason,
					approvalId: r.id,
					number: r.number
				});
			} else if (r.kind === "reverse") {
				const x = (r.sourceType === "issue" ? d.issues : r.sourceType === "transfer" ? d.transfers : r.sourceType === "adjustment" ? d.adjustments : r.sourceType === "pack" ? d.packs : d.consumptions).find((x) => x.id === r.sourceId && !x.reversedAt);
				if (!x) throw Error("الحركة غير موجودة أو تم عكسها");
				if (r.sourceType === "issue") {
					const row = wipRows(inv, x.orderId).find((i) => i.id === x.id);
					if (!row || row.pendingReturn > 0 || row.used > 0 || row.waste > 0) throw Error("توجد حركات تابعة؛ عالج الاستهلاك والهالك والمرتجعات أولًا");
					const amount = row.remaining;
					if (amount <= 0) throw Error("لا توجد كمية قابلة للعكس");
					d.returns.push({
						...base,
						issueId: x.id,
						orderId: x.orderId,
						lotId: x.lotId,
						quantity: amount,
						reason: r.reason,
						approvalId: r.id
					});
				}
				if (r.sourceType === "transfer") {
					const l = lot("TR-" + x.id);
					if (!x.receivedAt || l.available < x.quantity) throw Error("التحويل مستخدم أو محجوز؛ لا يمكن عكسه");
					d.transfers.push({
						...base,
						id: "REV-" + id,
						number: "TR-" + String(d.transfers.length + 1).padStart(7, "0"),
						sourceLotId: l.id,
						originLotId: l.originLotId || l.id,
						material: { ...x.material },
						code: x.code,
						name: x.name,
						unit: x.unit,
						batch: x.batch,
						quantity: x.quantity,
						fromWarehouse: x.toWarehouse,
						toWarehouse: x.fromWarehouse,
						day: dateInCairo(now),
						reason: r.reason,
						receivedAt: now,
						receivedBy: u.email,
						approvalId: r.id
					});
				}
				if (r.sourceType === "adjustment") {
					const l = lot(x.lotId);
					if (x.quantity > 0 && l.available < x.quantity) throw Error("كمية التسوية مستخدمة أو محجوزة");
					d.adjustments.push({
						...base,
						lotId: x.lotId,
						quantity: -x.quantity,
						reason: r.reason,
						approvalId: r.id
					});
				}
				if (r.sourceType === "pack") {
					if (d.deliveries.some((v) => v.lotId === x.outputLotId)) throw Error("تم تسليم الناتج؛ لا يمكن عكس ربط العبوات");
					x.reversedAt = now;
				}
				if (r.sourceType === "consumption") {
					const o = order(x.orderId);
					if (o.data.confirmations.length || c.trace.some((t) => t.consumptionId === x.id)) throw Error("الاستهلاك مرتبط بناتج؛ لا يمكن عكسه منفردًا");
					x.reversedAt = now;
					guardOrder = o;
				}
				x.reversedAt = now;
				x.reversedBy = u.email;
				x.reversalRequest = r.id;
			}
		}
		Object.assign(r, {
			status: b.decision === "A" ? "approved" : "rejected",
			decision: b.decision,
			decisionAt: now,
			decisionBy: u.email,
			decisionReason: reason
		});
		action = "قرار اعتماد " + r.number;
	} else if (op === "control_user_scope") {
		if (role !== "admin") throw Error("نطاق المستخدم من صلاحية مدير النظام");
		const email = required(b.email, "البريد الإلكتروني").toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error("البريد غير صحيح");
		if (!Array.isArray(b.lines) || !Array.isArray(b.warehouses) || b.lines.some((id) => !c.machines.some((m) => m.id === id && m.kind === "line")) || b.warehouses.some((code) => !inv.warehouses.some((w) => w.code === code))) throw Error("نطاق المستخدم غير صحيح");
		c.userScopes = c.userScopes.filter((r) => r.email !== email);
		c.userScopes.push({
			...base,
			email,
			lines: [...new Set(b.lines)],
			warehouses: [...new Set(b.warehouses)]
		});
		action = "تحديد نطاق المستخدم";
	} else if (op === "control_centre") {
		allowed("approve");
		const code = required(b.code, "كود مركز التكلفة"), name = required(b.name, "اسم مركز التكلفة");
		const old = c.costCentres.find((x) => x.code === code);
		if (old) Object.assign(old, {
			name,
			updatedAt: now,
			updatedBy: u.email
		});
		else c.costCentres.push({
			...base,
			code,
			name
		});
		action = "تعريف مركز تكلفة تشغيلي";
	} else if (op === "control_machine") {
		allowed("maintain");
		if (!["admin", "plant_manager"].includes(role)) throw Error("تعريف الخطوط والمعدات من صلاحية مدير المصنع");
		const code = required(b.code, "كود المعدة"), name = required(b.name, "اسم المعدة");
		if (!["line", "machine"].includes(b.kind)) throw Error("اختر خطًا أو معدة");
		if (b.costCentre && !c.costCentres.some((x) => x.code === b.costCentre)) throw Error("اختر مركز التكلفة");
		const old = c.machines.find((x) => x.code === code), lineId = b.kind === "machine" ? b.lineId || old?.lineId : null;
		if (b.kind === "machine" && !c.machines.some((m) => m.id === lineId && m.kind === "line")) throw Error("اربط المعدة بخط الإنتاج");
		if (old && (old.kind !== b.kind || (old.lineId || null) !== lineId && (old.qualityHold || c.incidents.some((i) => i.machineId === old.id && !i.closedAt)))) throw Error("لا يمكن تغيير ربط معدة موقوفة");
		if (old) Object.assign(old, {
			name,
			lineId,
			costCentre: b.costCentre || "",
			updatedAt: now,
			updatedBy: u.email
		});
		else c.machines.push({
			...base,
			code,
			name,
			kind: b.kind,
			lineId,
			costCentre: b.costCentre || "",
			status: "ready"
		});
		action = "تعريف خط أو معدة";
	} else if (op === "control_equipment_status" || op === "control_equipment_quality") {
		allowed(op === "control_equipment_status" ? "equipment" : "quality");
		const m = c.machines.find((m) => m.id === b.machineId);
		if (!m) throw Error("اختر المعدة");
		const lineId = m.kind === "line" ? m.id : m.lineId;
		assertScope(inv, u, { lineId });
		const clock = operatingShift(now), value = clock.day;
		assertDayOpen(inv, value);
		const shift = clock.name, o = b.orderId ? order(b.orderId) : null;
		if (o && o.data.lineId !== lineId) throw Error("الأمر مرتبط بخط آخر");
		const record = {
			...base,
			machineId: m.id,
			machineName: m.name,
			lineId,
			day: value,
			shift,
			orderId: o?.id || null,
			notes: optional(b.notes)
		};
		if (op === "control_equipment_status") {
			if (![
				"ready",
				"running",
				"down",
				"maintenance"
			].includes(b.status)) throw Error("اختر الحالة الفنية");
			const active = c.incidents.some((r) => r.machineId === m.id && !r.closedAt);
			if (["ready", "running"].includes(b.status) && (active || ["down", "maintenance"].includes(m.status) && ![
				"admin",
				"maintenance",
				"plant_manager"
			].includes(role))) throw Error("أغلق العطل بواسطة الصيانة قبل إعلان الجاهزية");
			if (["down", "maintenance"].includes(b.status)) {
				const reason = required(b.notes, "سبب التوقف");
				if (!active) c.incidents.push({
					...base,
					number: "MT-" + String(c.incidents.length + 1).padStart(7, "0"),
					machineId: m.id,
					machineName: m.name,
					start: now,
					reason,
					orderId: o?.id || null,
					requiresQuality: b.requiresQuality !== false,
					day: value,
					shift
				});
				if (b.requiresQuality !== false) {
					m.qualityHold = true;
					m.qualityStatus = "H";
					m.qualityReason = reason;
					m.qualityHoldAt = now;
				}
			}
			m.status = b.status;
			m.updatedAt = now;
			if (["down", "maintenance"].includes(b.status)) m.statusAt = now;
			c.equipmentChecks.push({
				...record,
				number: "EC-" + String(c.equipmentChecks.length + 1).padStart(7, "0"),
				status: b.status
			});
			action = "تسجيل حالة المعدة بالشفت";
		} else {
			if (![
				"A",
				"H",
				"R"
			].includes(b.decision)) throw Error("اختر قرار الجودة");
			if (b.decision === "A" && (!["ready", "running"].includes(m.status) || c.incidents.some((r) => r.machineId === m.id && !r.closedAt))) throw Error("المعدة غير جاهزة فنيًا لاعتماد الجودة");
			const reason = b.decision === "A" ? optional(b.reason) : required(b.reason, "سبب قرار الجودة");
			const r = {
				...record,
				number: "EQ-" + String(c.equipmentReviews.length + 1).padStart(7, "0"),
				decision: b.decision,
				reason,
				cleanliness: optional(b.cleanliness),
				integrity: optional(b.integrity),
				readings: optional(b.readings)
			};
			c.equipmentReviews.push(r);
			m.qualityHold = b.decision !== "A";
			m.qualityStatus = b.decision;
			m.qualityReason = reason;
			m.qualityAt = now;
			m.qualityBy = u.email;
			action = "فحص جودة وجاهزية المعدة";
		}
	} else if (op === "control_incident") {
		allowed("reportEquipment");
		const m = c.machines.find((m) => m.id === b.machineId);
		if (!m) throw Error("اختر المعدة");
		const lineId = m.kind === "line" ? m.id : m.lineId;
		assertScope(inv, u, { lineId });
		const start = stamp(b.start);
		assertDayOpen(inv, operatingShift(start).day);
		if (c.incidents.some((i) => i.machineId === m.id && !i.closedAt)) throw Error("يوجد عطل مفتوح للمعدة");
		const o = b.orderId ? order(b.orderId) : null;
		if (o && o.data.lineId !== lineId) throw Error("الأمر مرتبط بخط آخر");
		const reason = required(b.reason, "سبب التوقف");
		c.incidents.push({
			...base,
			number: "MT-" + String(c.incidents.length + 1).padStart(7, "0"),
			machineId: m.id,
			machineName: m.name,
			start,
			reason,
			orderId: o?.id || null,
			requiresQuality: b.requiresQuality === true
		});
		m.status = "down";
		m.statusAt = now;
		if (b.requiresQuality === true) {
			m.qualityHold = true;
			m.qualityStatus = "H";
			m.qualityReason = reason;
			m.qualityHoldAt = now;
		}
		action = "تسجيل توقف معدة";
	} else if (op === "control_incident_close") {
		allowed("maintain");
		const r = c.incidents.find((r) => r.id === b.incidentId && !r.closedAt);
		if (!r) throw Error("العطل غير متاح");
		const m = c.machines.find((m) => m.id === r.machineId);
		assertScope(inv, u, { lineId: m?.kind === "line" ? m.id : m?.lineId });
		const end = stamp(b.end);
		assertDayOpen(inv, operatingShift(end).day);
		if (end < r.start) throw Error("نهاية التوقف تسبق البداية");
		r.closedAt = now;
		r.end = end;
		r.minutes = Math.round((Date.parse(end) - Date.parse(r.start)) / 6e4);
		r.repair = required(b.reason, "الإصلاح المنفذ");
		r.notes = optional(b.notes);
		r.closedBy = u.email;
		if (m && !c.incidents.some((i) => i.machineId === m.id && !i.closedAt)) {
			m.status = "ready";
			m.statusAt = now;
			if (r.requiresQuality) {
				m.qualityHold = true;
				m.qualityStatus = "H";
				m.qualityReason = "بانتظار فحص الجودة بعد الإصلاح";
				m.qualityHoldAt = now;
			}
		}
		action = "إغلاق العطل وتأكيد الجاهزية الفنية";
	} else if (op === "control_cip") {
		allowed("cip");
		const m = c.machines.find((m) => m.id === b.lineId && m.kind === "line");
		if (!m) throw Error("اختر خط الإنتاج");
		assertScope(inv, u, { lineId: m.id });
		const start = stamp(b.start), end = stamp(b.end);
		if (start > end) throw Error("نهاية CIP تسبق البداية");
		assertDayOpen(inv, operatingShift(end).day);
		c.cip.push({
			...base,
			number: "CIP-" + String(c.cip.length + 1).padStart(7, "0"),
			lineId: m.id,
			lineName: m.name,
			start,
			end,
			reference: required(b.reference, "مرجع إجراء CIP المعتمد"),
			readings: required(b.readings, "القراءات والنتائج"),
			notes: optional(b.notes)
		});
		action = "تسجيل تنفيذ CIP";
	} else if (op === "control_cip_quality") {
		allowed("quality");
		const r = c.cip.find((r) => r.id === b.cipId && !r.decision);
		if (!r) throw Error("فحص CIP غير متاح");
		assertScope(inv, u, { lineId: r.lineId });
		if (!["A", "R"].includes(b.decision)) throw Error("اختر قرار الجودة");
		r.decision = b.decision;
		r.qualityBy = u.email;
		r.qualityAt = now;
		r.reason = required(b.reason, "نتيجة مراجعة CIP");
		action = "اعتماد فحص CIP";
	} else if (op === "control_trace") {
		allowed("trace");
		const usage = d.consumptions.find((x) => x.id === b.consumptionId && !x.reversedAt);
		if (!usage) throw Error("اختر استهلاكًا فعليًا");
		const o = order(usage.orderId), l = lot(b.outputLotId), amount = qty(b.quantity);
		if (l.orderId !== o.id || !l.id.startsWith("P-")) throw Error("اختر ناتجًا لنفس أمر التشغيل");
		if (amount + c.trace.filter((t) => t.consumptionId === usage.id).reduce((n, t) => n + t.quantity, 0) > usage.quantity) throw Error("كمية التتبع تتجاوز الاستهلاك غير الموزع");
		c.trace.push({
			...base,
			consumptionId: usage.id,
			issueId: usage.issueId,
			orderId: o.id,
			outputLotId: l.id,
			code: usage.code,
			quantity: amount
		});
		guardOrder = o;
		action = "ربط الاستهلاك بباتش الناتج";
	} else if (op === "control_day_close") {
		allowed("day");
		const value = day(b.day);
		if (value > dateInCairo(now) || c.closedDays.some((x) => x.day === value && !x.reopenedAt)) throw Error("اليوم مستقبلي أو مغلق بالفعل");
		if (inv.orders.some((o) => o.data.shifts.some((s) => s.day === value && !s.closedAt))) throw Error("أغلق شفتات اليوم أولًا");
		if (inv.lots.some((l) => l.orderId && inv.orders.find((o) => o.id === l.orderId)?.data.confirmations.some((x) => x.batch === l.batch && x.day === value) && (l.quality === "H" || l.warehousePending))) throw Error("استكمل جودة واستلام ناتج اليوم");
		c.closedDays.push({
			...base,
			day: value,
			reason: required(b.reason, "ملاحظات إغلاق اليوم")
		});
		action = "إغلاق يوم التشغيل";
	} else if (op === "control_day_reopen") {
		allowed("day");
		const r = c.closedDays.find((r) => r.id === b.dayId && !r.reopenedAt);
		if (!r) throw Error("اليوم ليس مغلقًا");
		r.reopenedAt = now;
		r.reopenedBy = u.email;
		r.reopenReason = required(b.reason, "سبب إعادة الفتح");
		action = "إعادة فتح يوم التشغيل";
	} else throw Error("إجراء رقابي غير معروف");
	c.audit.push({
		...base,
		action,
		role
	});
	tagNewMovements(d, now);
	const guard = guardOrder ? " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=?)" : "", args = guardOrder ? [
		guardOrder.id,
		demo,
		guardOrder.version
	] : [];
	if (!(inv.version === 0 ? await db.run("INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1" + guard, [
		demo,
		JSON.stringify(d),
		...args
	]) : await db.run("UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?" + guard, [
		JSON.stringify(d),
		demo,
		inv.version,
		...args
	])).changes) throw Error("تغيرت البيانات؛ حدّث الصفحة وأعد المحاولة");
	return {
		ok: true,
		...[
			"control_equipment_status",
			"control_equipment_quality",
			"control_incident_close",
			"control_day_reopen"
		].includes(op) ? await safeAutomaticFilling(db, u, demo) : {}
	};
}
//#endregion
//#region lib/chemical-limits.ts
var chemicalLimits = [
	{
		key: "guava",
		name: "جوافة",
		codes: ["300003"],
		aliases: [
			"جوافة",
			"جوافه",
			"guava"
		],
		brix: 7,
		phMin: 3.8,
		phMax: 4.2,
		iodine: false
	},
	{
		key: "mango",
		name: "مانجو",
		codes: ["300004"],
		aliases: ["مانجو", "mango"],
		brix: 13.5,
		phMin: 3.6,
		phMax: 4.5,
		iodine: false
	},
	{
		key: "tomato",
		name: "طماطم",
		codes: ["300000"],
		aliases: ["طماطم", "tomato"],
		brix: 4.5,
		phMin: null,
		phMax: 4.5,
		iodine: true
	},
	{
		key: "apricot",
		name: "مشمش",
		codes: ["300006"],
		aliases: ["مشمش", "apricot"],
		brix: 11,
		phMin: 3,
		phMax: 4.5,
		iodine: false
	},
	{
		key: "peach",
		name: "خوخ",
		codes: [],
		aliases: ["خوخ", "peach"],
		brix: 10,
		phMin: 3.2,
		phMax: 4.1,
		iodine: false
	},
	{
		key: "chilli",
		name: "فلفل حار",
		codes: ["300005"],
		aliases: [
			"فلفل",
			"chilli",
			"chili"
		],
		brix: 8,
		phMin: 4.2,
		phMax: 5.2,
		iodine: false
	},
	{
		key: "strawberry",
		name: "فراولة",
		codes: ["300001", "300002"],
		aliases: [
			"فراولة",
			"فراوله",
			"strawberry",
			"strawberyy"
		],
		brix: 7.5,
		phMin: 3,
		phMax: 4,
		iodine: false
	}
];
function fruitChemicalLimit(ticket) {
	const direct = chemicalLimits.find((l) => l.codes.includes(String(ticket?.fruitCode)));
	if (direct) return direct;
	const name = String(ticket?.fruit || "").trim().toLowerCase();
	const matches = chemicalLimits.filter((l) => l.aliases.some((a) => name === a || name.startsWith(a + " ")));
	return matches.length === 1 ? matches[0] : null;
}
function chemicalSummary(b, ticket) {
	const limit = fruitChemicalLimit(ticket), reasons = [];
	const has = (k) => b[k] != null && String(b[k]).trim() !== "" && Number.isFinite(Number(b[k]));
	if (limit) {
		if (has("brix") && Number(b.brix) < limit.brix) reasons.push("Brix أقل من الحد المسموح للصنف");
		if (has("ph") && (limit.phMin !== null && Number(b.ph) < limit.phMin || Number(b.ph) > limit.phMax)) reasons.push("pH خارج حدود الصنف");
		if (limit.iodine && b.iodine === "FAIL") reasons.push("Iodine غير مطابق");
	}
	return {
		limit,
		reasons,
		complete: Boolean(has("brix") && has("ph") && (!limit?.iodine || ["PASS", "FAIL"].includes(b.iodine)))
	};
}
//#endregion
//#region lib/agricultural-quality.ts
var truckChecks = [
	["pests", "وجود آفات"],
	["foreignMatter", "مواد غريبة"],
	["chemicals", "مواد كيميائية"],
	["rust", "صدأ"],
	["leakage", "تسييل"]
];
var fruitChecks = [
	["mould", "فطر وعفن"],
	["insects", "إصابات حشرية"],
	["blackScorch", "لفح سوداء"],
	["unripe", "غير ناضج"],
	["yellow", "أصفر"],
	["broken", "مكسور"],
	["small", "أحجام صغيرة"],
	["branches", "أغصان وأوراق"]
];
function inspectionSummary(b, ticket = {}) {
	const value = (k) => Number(b["fruit_" + k]) || 0, round = (v) => Math.round(v * 1e3) / 1e3;
	const complete = truckChecks.every(([k]) => ["PASS", "FAIL"].includes(b["truck_" + k])) && fruitChecks.every(([k]) => b["fruit_" + k] !== "" && b["fruit_" + k] != null && Number.isFinite(Number(b["fruit_" + k])) && Number(b["fruit_" + k]) >= 0 && Number(b["fruit_" + k]) <= 100);
	const total = round(fruitChecks.reduce((n, [k]) => n + value(k), 0)), groupTotal = round(value("yellow") + value("small") + value("branches"));
	const failed = truckChecks.filter(([k]) => b["truck_" + k] === "FAIL").map(([k]) => k), reasons = [], manualReasons = [];
	if (failed.length) reasons.push("يوجد بند غير مطابق في فحص السيارة.");
	if (value("insects") > 0) reasons.push("وجود إصابة حشرية يستدعي الرفض");
	if (value("mould") > 0) reasons.push("وجود إصابة فطرية يستدعي الرفض");
	if (value("blackScorch") > 0) reasons.push("وجود لطعة سوداء يستدعي الرفض");
	if (value("unripe") > 5) reasons.push("غير الناضج أكثر من 5%");
	if (value("broken") > 5) reasons.push("المكسور أو المهروس أكثر من 5%");
	if (groupTotal > 15) reasons.push("مجموعة الأصفر والصغير والأغصان أكثر من 15%");
	if (total > 20) reasons.push("مجموع عيوب الثمار أكثر من 20%");
	const chemical = chemicalSummary(b, ticket);
	reasons.push(...chemical.reasons);
	if (!chemical.limit) reasons.push("لا توجد مواصفة كيميائية لهذا الصنف؛ راجع تعريف الصنف قبل القبول");
	const groupDeduction = groupTotal <= 5 ? 0 : {
		"6": 3,
		"8": 4,
		"10": 6,
		"12": 8,
		"14": 10
	}[String(groupTotal)] ?? null;
	if (groupDeduction === null && groupTotal <= 15) manualReasons.push("نسبة المجموعة غير محددة بجدول الخصم؛ تحددها الجودة");
	if (value("unripe") === 5 || value("broken") === 5) manualReasons.push("حد 5% لغير الناضج أو المكسور يحتاج اعتماد نسبة الخصم يدويًا");
	return {
		chemical,
		complete,
		total,
		groupTotal,
		groupDeduction,
		failed,
		reasons,
		manualReasons,
		calculatedDeduction: !complete || reasons.length || manualReasons.length ? null : round(value("unripe") + value("broken") + (groupDeduction || 0)),
		recommendation: reasons.length ? "R" : !complete ? "PENDING" : manualReasons.length ? "REVIEW" : "A"
	};
}
function validateAgriculturalInspection(b, now, ticket = {}) {
	const text = (v, label) => {
		if (typeof v !== "string" || !v.trim() || v.trim().length > 160) throw Error("أدخل " + label + " بشكل صحيح");
		return v.trim();
	};
	const number = (v, label, max) => {
		const n = Number(v);
		if (v == null || String(v).trim() === "" || !Number.isFinite(n) || n < 0 || n > max || Math.abs(n * 1e3 - Math.round(n * 1e3)) > 1e-5) throw Error("قيمة غير صالحة: " + label);
		return n;
	};
	const summary = inspectionSummary(b, ticket), reject = b.decision === "R";
	if (!["A", "R"].includes(b.decision)) throw Error("اختر A أو R");
	if (b.confirm !== true) throw Error("أكد قرار الجودة");
	const disposition = qualityDisposition(b, summary.reasons);
	const truck = {}, fruit = {};
	for (const [k, label] of truckChecks) {
		const v = b["truck_" + k];
		if (reject && (v == null || v === "")) {
			truck[k] = null;
			continue;
		}
		if (!["PASS", "FAIL"].includes(v)) throw Error("استكمل فحص السيارة: " + label);
		truck[k] = v;
	}
	for (const [k, label] of fruitChecks) {
		const v = b["fruit_" + k];
		fruit[k] = reject && (v == null || v === "") ? null : number(v, label, 100);
	}
	if (summary.total > 100) throw Error("مجموع نسب الثمار المعيبة لا يمكن أن يتجاوز 100%");
	if (!reject && ![
		"A",
		"B",
		"C"
	].includes(b.inspectionShift)) throw Error("اختر شفت الفحص");
	if (b.inspectionShift && ![
		"A",
		"B",
		"C"
	].includes(b.inspectionShift)) throw Error("اختر شفت الفحص");
	const finalDeduction = reject ? null : number(b.deduction, "نسبة الخصم النهائية", 20);
	const changed = !reject && (summary.calculatedDeduction === null || finalDeduction !== summary.calculatedDeduction);
	const reason = reject || changed ? text(b.reason, "سبب قرار الجودة أو تعديل الخصم") : String(b.reason || "").trim().slice(0, 160);
	const optionalText = (k, label) => reject ? b[k] ? text(b[k], label) : null : text(b[k], label);
	const optionalNumber = (k, max) => reject && (b[k] == null || b[k] === "") ? null : number(b[k], k, max);
	let iodine = null;
	if (b.iodine != null && b.iodine !== "") {
		if (!["PASS", "FAIL"].includes(b.iodine)) throw Error("اختر مطابق أو غير مطابق لليود");
		iodine = b.iodine;
	}
	if (!reject && summary.chemical.limit?.iodine && !iodine) throw Error("استكمل فحص اليود للطماطم");
	return {
		schemaVersion: 5,
		source: "بيان نسب الخصم + مواصفات الاستلام 2026-10-20",
		policyVersion: "receiving-v5-manual",
		threshold: 20,
		maxDeduction: 20,
		chemicalLimits: summary.chemical.limit,
		chemicalComplete: summary.chemical.complete,
		groupBasis: "yellow+small+branches",
		groupTotal: summary.groupTotal,
		groupDeduction: summary.groupDeduction,
		rejectionReasons: summary.reasons,
		manualReasons: summary.manualReasons,
		truck,
		fruit,
		totalDefects: summary.total,
		calculatedDeduction: summary.calculatedDeduction,
		finalDeduction,
		recommendation: summary.recommendation,
		failedChecks: summary.failed,
		decision: b.decision,
		...disposition,
		reason,
		shift: b.inspectionShift || null,
		allocationNo: optionalText("allocationNo", "رقم التخصيص"),
		brix: optionalNumber("brix", 100),
		ph: optionalNumber("ph", 14),
		iodine,
		inspectorName: optionalText("inspectorName", "اسم القائم بالفحص"),
		approvedAt: now,
		earlyRejection: reject && (!summary.complete || !summary.chemical.complete)
	};
}
//#endregion
//#region lib/warehouse-cycle.ts
async function warehouseCycle(db, u, b) {
	u = operator(u, b.action);
	const permissions = {
		cycle_fruit_issue: ["production"],
		cycle_receive: ["warehouse"],
		cycle_incoming_quality: ["quality"],
		cycle_request: ["production"],
		cycle_cancel_request: ["production"],
		cycle_consume: ["production"],
		cycle_pack: ["production"],
		cycle_return_request: ["production"],
		cycle_cancel_return: ["production"],
		cycle_return_accept: ["warehouse"],
		cycle_customer: ["warehouse"],
		cycle_deliver: ["warehouse"],
		cycle_container_return: ["warehouse"],
		cycle_container_release: ["quality"],
		cycle_settle: []
	};
	const op = b.action;
	if (!permissions[op] || u.role !== "admin" && !permissions[op].includes(u.role)) throw Error("لا توجد صلاحية لهذه الحركة");
	const demo = b.demo === true ? 1 : 0, inv = await inventorySnapshot(db, demo), d = inv.state;
	if (!Number.isInteger(b.inventoryVersion) || b.inventoryVersion !== inv.version) throw Error("الأرصدة تغيرت من جهاز آخر؛ حدّث الصفحة");
	const now = (/* @__PURE__ */ new Date()).toISOString(), id = crypto.randomUUID();
	if (![
		"cycle_customer",
		"cycle_incoming_quality",
		"cycle_container_release"
	].includes(op)) assertDayOpen(inv, operatingShift(now).day);
	let description = "", guardOrder = null, guardTicket = null;
	const serial = (prefix, rows) => prefix + "-" + String(rows.length + 1).padStart(7, "0");
	const base = {
		id,
		at: now,
		by: u.email,
		...shiftMetadata(now)
	};
	const warehouse = () => {
		assertWarehouse(u, b.warehouse);
		assertScope(inv, u, { warehouse: b.warehouse });
		if (!inv.warehouses.some((w) => w.code === b.warehouse)) throw Error("اختر المخزن");
		return b.warehouse;
	};
	const lot = () => {
		const l = inv.lots.find((l) => l.id === b.lotId);
		if (!l) throw Error("الباتش غير موجود");
		assertWarehouse(u, l.warehouse);
		assertScope(inv, u, { warehouse: l.warehouse });
		if (l.orderId) guardOrder = inv.orders.find((o) => o.id === l.orderId);
		return l;
	};
	const order = (id) => {
		const o = inv.orders.find((o) => o.id === Number(id));
		if (!o || o.status !== "open" || o.version !== b.orderVersion) throw Error("اختر أمرًا مفتوحًا وحدّث بياناته");
		assertReleased(inv, o);
		assertScope(inv, u, { lineId: o.data.lineId });
		guardOrder = o;
		if (![
			"cycle_request",
			"cycle_cancel_request",
			"cycle_return_request",
			"cycle_cancel_return",
			"cycle_return_accept"
		].includes(op)) ensureAutoShift(inv, o, u, now);
		return o;
	};
	const workingIssue = () => {
		const i = wipRows(inv).find((i) => i.id === b.issueId);
		if (!i) throw Error("اختر مادة مصروفة ومستلمة للأمر");
		return {
			i,
			o: order(i.orderId)
		};
	};
	const shift = (o) => ensureAutoShift(inv, o, u, now);
	const day = (value) => {
		const s = required(value, "التاريخ");
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw Error("تاريخ غير صحيح");
		return s;
	};
	if (op === "cycle_receive") {
		const l = lot();
		if (l.directBulk) throw Error("البلك ينتقل مباشرة للتعبئة بعد الجودة ولا يحتاج استلام مخازن");
		if (l.directFruit) throw Error("الثمار تستلم مباشرة بحوض الإنتاج وتسجل بالأرصدة دون اعتماد المخزن");
		if (!l.warehousePending) throw Error("تم استلام الباتش بالمخزن بالفعل");
		if (l.quality !== "A") throw Error("يجب اعتماد الجودة بالقبول قبل تأكيد استلام المخزن");
		if (qty(b.quantity) !== l.expectedQuantity) throw Error("كمية الاستلام لا تطابق المستند؛ راجع الفرق قبل الاعتماد");
		if (l.id.startsWith("T-")) guardTicket = await db.first("SELECT id,version FROM tickets WHERE id=? AND demo=?", [Number(l.id.slice(2)), demo]);
		d.warehouseReceipts.push({
			...base,
			number: serial("GR", d.warehouseReceipts),
			lotId: l.id,
			code: l.code,
			name: l.name,
			unit: l.unit,
			quantity: l.expectedQuantity,
			warehouse: warehouse(),
			reference: l.source
		});
		description = "اعتماد استلام مخزني";
	}
	if (op === "cycle_fruit_issue") {
		const o = order(b.orderId), l = lot(), s = shift(o), amount = qty(b.quantity);
		assertDayOpen(inv, s.day);
		assertUsable(l, s.day);
		if (!l.directFruit || l.warehouse !== "PROD" || o.data.type !== "Bulk" || l.quality !== "A" || l.warehousePending) throw Error("اختر شحنة ثمار مستلمة بالحوض وأمر Bulk");
		if (!o.data.requirements.some((r) => r.code === l.code)) throw Error("الثمار لا تطابق مخطط صرف الأمر");
		const own = d.reservations.filter((r) => r.orderId === o.id && r.lotId === l.id && r.remaining > 0), ownQty = own.reduce((n, r) => n + r.remaining, 0);
		if (amount > round$1(l.available + ownQty)) throw Error("كمية الثمار تتجاوز المتاح بالحوض");
		let left = amount;
		for (const r of own) {
			const take = Math.min(left, r.remaining);
			r.remaining = round$1(r.remaining - take);
			left = round$1(left - take);
		}
		d.issues.push({
			...base,
			number: serial("GI", d.issues),
			orderId: o.id,
			lotId: l.id,
			code: l.code,
			name: l.name,
			category: l.category,
			unit: l.unit,
			warehouse: l.warehouse,
			batch: l.batch,
			quantity: amount,
			acceptedAt: now,
			acceptedBy: u.email,
			shiftId: s.id,
			day: s.day,
			directFruit: true,
			sourceReference: l.source,
			notes: required(b.reason, "مرجع الصرف من الحوض")
		});
		description = "استلام ثمار بالحوض وصرف فعلي للأمر";
	}
	if (op === "cycle_incoming_quality") {
		const l = lot();
		if (!l.requiresQuality || d.incomingInspections.some((q) => q.lotId === l.id && ["A", "R"].includes(q.decision))) throw Error("الفحص غير متاح أو معتمد بالفعل");
		if (![
			"A",
			"R",
			"H"
		].includes(b.decision)) throw Error("اختر قرار الجودة");
		if (b.decision === "R") required(b.reason, "سبب الرفض");
		d.incomingInspections = d.incomingInspections.filter((q) => q.lotId !== l.id);
		d.incomingInspections.push({
			...base,
			...validateMaterialInspection({
				...b,
				qcProfile: l.qcProfile || ""
			}),
			...qualityDisposition(b),
			lotId: l.id,
			decision: b.decision,
			reason: String(b.reason || "").slice(0, 160)
		});
		description = "فحص وارد مخزني";
	}
	if (op === "cycle_request") {
		const o = order(b.orderId), r = o.data.requirements.find((r) => r.code === b.code);
		if (!r) throw Error("أضف احتياج المادة إلى الأمر أولًا: " + b.code);
		const amount = qty(b.quantity), net = d.issues.filter((i) => i.orderId === o.id && i.code === b.code).reduce((s, i) => s + i.quantity - d.returns.filter((r) => r.issueId === i.id).reduce((n, r) => n + r.quantity, 0), 0);
		const outstanding = d.supplyRequests.filter((r) => r.orderId === o.id && r.code === b.code && !r.cancelledAt).reduce((s, r) => s + Math.max(0, r.quantity - d.preparations.filter((p) => p.supplyRequestId === r.id).reduce((n, p) => n + p.received, 0)), 0);
		const unlinked = d.preparations.filter((p) => p.orderId === o.id && p.code === b.code && !p.supplyRequestId).reduce((s, p) => s + p.quantity - p.received - p.cancelled, 0);
		if (round$1(amount + net + outstanding + unlinked) > r.quantity) throw Error("الكمية أكبر من المتبقي للاحتياج");
		d.supplyRequests.push({
			...base,
			number: serial("MR", d.supplyRequests),
			orderId: o.id,
			code: r.code,
			name: r.name,
			unit: r.unit,
			quantity: amount,
			neededDate: day(b.neededDate),
			reason: String(b.reason || "").slice(0, 160)
		});
		description = "طلب صرف للإنتاج";
	}
	if (op === "cycle_cancel_request") {
		const r = d.supplyRequests.find((r) => r.id === b.requestId && !r.cancelledAt);
		if (!r) throw Error("طلب الصرف غير متاح");
		order(r.orderId);
		if (d.preparations.some((p) => p.supplyRequestId === r.id && p.quantity > p.received + p.cancelled)) throw Error("ألغِ التجهيز المعلق أولًا");
		r.cancelledAt = now;
		r.cancelledBy = u.email;
		r.reason = required(b.reason, "السبب");
		description = "إلغاء طلب صرف";
	}
	if ([
		"cycle_consume",
		"cycle_pack",
		"cycle_return_request"
	].includes(op)) {
		const { i, o } = workingIssue(), amount = qty(b.quantity);
		if (amount > i.free) throw Error("الكمية تتجاوز المتبقي لدى الإنتاج");
		const common = {
			...base,
			orderId: o.id,
			issueId: i.id,
			code: i.code,
			name: i.name,
			unit: i.unit,
			quantity: amount
		};
		if (op === "cycle_consume") {
			if (i.category === "packaging") throw Error("سجل مواد التعبئة على دفعة الناتج");
			const s = shift(o);
			assertDayOpen(inv, s.day);
			let output = null;
			if (b.outputLotId) {
				output = inv.lots.find((l) => l.id === b.outputLotId && l.orderId === o.id && l.id.startsWith("P-") && !l.delivered);
				if (!output) throw Error("اختر دفعة ناتج لنفس الأمر قبل التسليم");
			}
			d.consumptions.push({
				...common,
				outputLotId: output?.id || null,
				shiftId: s.id,
				day: s.day,
				reason: required(b.reason, "مرجع الاستهلاك")
			});
			if (output) controls(d).trace.push({
				...base,
				id: "TRACE-" + id,
				consumptionId: id,
				issueId: i.id,
				orderId: o.id,
				outputLotId: output.id,
				code: i.code,
				quantity: amount
			});
			description = "تسجيل استهلاك فعلي";
		} else if (op === "cycle_pack") {
			const s = shift(o), l = lot(), m = inv.materials.find((m) => m.code === i.code);
			if (i.category !== "packaging" || !["finished", ...o.data.cycleVersion >= 3 ? ["semi", "byproduct"] : []].includes(l.category) || l.orderId !== o.id || l.delivered > 0) throw Error("اختر دفعة منتج تام لنفس الأمر قبل التسليم");
			if (i.unit === "PC" && !Number.isInteger(amount)) throw Error("عدد العبوات يجب أن يكون صحيحًا");
			d.packs.push({
				...common,
				outputLotId: l.id,
				shiftId: s.id,
				day: s.day,
				returnable: Boolean(m?.returnable),
				sourceBatch: i.batch,
				sourceLotId: i.lotId
			});
			description = "ربط العبوات بدفعة المنتج";
		} else {
			d.returnRequests.push({
				...common,
				number: serial("PR", d.returnRequests),
				lotId: i.lotId,
				warehouse: i.warehouse,
				reason: required(b.reason, "سبب المرتجع")
			});
			description = "طلب مرتجع إنتاج";
		}
	}
	if (op === "cycle_cancel_return") {
		const r = d.returnRequests.find((r) => r.id === b.requestId && !r.acceptedAt && !r.cancelledAt);
		if (!r) throw Error("طلب المرتجع غير متاح");
		order(r.orderId);
		r.cancelledAt = now;
		r.cancelledBy = u.email;
		r.cancelReason = required(b.reason, "السبب");
		description = "إلغاء طلب مرتجع";
	}
	if (op === "cycle_return_accept") {
		const r = d.returnRequests.find((r) => r.id === b.requestId && !r.acceptedAt && !r.cancelledAt);
		if (!r) throw Error("طلب المرتجع غير متاح");
		order(r.orderId);
		assertWarehouse(u, r.warehouse);
		assertScope(inv, u, { warehouse: r.warehouse });
		const i = wipRows(inv, r.orderId).find((i) => i.id === r.issueId);
		if (!i || r.quantity > i.remaining) throw Error("المرتجع يتجاوز المتبقي لدى الإنتاج");
		r.acceptedAt = now;
		r.acceptedBy = u.email;
		d.returns.push({
			...base,
			issueId: r.issueId,
			orderId: r.orderId,
			lotId: r.lotId,
			quantity: r.quantity,
			reason: r.reason,
			requestId: r.id,
			number: r.number
		});
		description = "اعتماد مرتجع الإنتاج بالمخزن";
	}
	if (op === "cycle_customer") {
		const name = required(b.name, "اسم العميل");
		if (b.customerId) {
			const existing = d.customers.find((c) => c.id === b.customerId);
			if (!existing) throw Error("العميل غير موجود");
			existing.name = name;
			existing.updatedAt = now;
			existing.updatedBy = u.email;
		} else {
			let next = d.customers.reduce((n, c) => Math.max(n, /^CUS-\d+$/.test(c.code) ? Number(c.code.slice(4)) : 0), 0) + 1;
			const code = "CUS-" + String(next).padStart(7, "0");
			d.customers.push({
				...base,
				code,
				name
			});
		}
		description = "حفظ العميل";
	}
	if (op === "cycle_deliver") {
		const l = lot(), amount = qty(b.quantity), c = d.customers.find((c) => c.id === b.customerId);
		if (!c) throw Error("اختر العميل");
		assertUsable(l, dateInCairo(now));
		assertWarehouse(u, l.warehouse);
		if (l.category !== "finished" || l.quality !== "A" || l.warehousePending || amount > l.available) throw Error("المنتج غير متاح للتسليم بهذه الكمية");
		const packs = d.packs.filter((p) => p.outputLotId === l.id && !p.reversedAt);
		if (!packs.length) throw Error("سجل العبوات الفعلية على دفعة المنتج أولًا");
		if (!Array.isArray(b.packages) || !b.packages.length || b.packages.length > 100 || new Set(b.packages.map((p) => p.packId)).size !== b.packages.length) throw Error("راجع بنود العبوات المسلمة");
		const packages = b.packages.map((line) => {
			const p = packs.find((p) => p.id === line.packId), q = qty(line.quantity);
			if (!p || p.unit === "PC" && !Number.isInteger(q)) throw Error("راجع عدد العبوات");
			const sent = d.deliveries.flatMap((x) => x.packages).filter((x) => x.packId === p.id).reduce((s, x) => s + x.quantity, 0);
			if (q > round$1(p.quantity - sent)) throw Error("عدد العبوات يتجاوز المتبقي على الدفعة");
			return {
				packId: p.id,
				code: p.code,
				name: p.name,
				unit: p.unit,
				quantity: q,
				returnable: p.returnable
			};
		});
		if (amount === l.balance) {
			for (const p of packs) if (round$1(d.deliveries.flatMap((x) => x.packages).filter((x) => x.packId === p.id).reduce((s, x) => s + x.quantity, 0) + (packages.find((x) => x.packId === p.id)?.quantity || 0)) !== p.quantity) throw Error("التسليم النهائي يجب أن يشمل كل العبوات المتبقية على الدفعة");
		}
		const due = packages.some((p) => p.returnable) ? day(b.due) : "";
		const today = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Africa/Cairo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		}).format(/* @__PURE__ */ new Date());
		if (due && due < today) throw Error("موعد الإرجاع يسبق تاريخ التسليم");
		d.deliveries.push({
			...base,
			number: serial("DN", d.deliveries),
			lotId: l.id,
			code: l.code,
			name: l.name,
			batch: l.batch,
			warehouse: l.warehouse,
			unit: l.unit,
			quantity: amount,
			customerId: c.id,
			customer: c.name,
			customerCode: c.code,
			due,
			packages,
			reference: required(b.reference, "مرجع التسليم")
		});
		description = "تسليم منتج تام للعميل";
	}
	if (["cycle_container_return", "cycle_settle"].includes(op)) {
		const balance = custodyRows(inv).find((r) => r.deliveryId === b.deliveryId && r.packId === b.packId), amount = qty(b.quantity);
		if (!balance || amount > balance.remaining || !Number.isInteger(amount)) throw Error("الكمية تتجاوز عهدة العميل أو ليست عددًا صحيحًا");
		const common = {
			...base,
			number: serial(op === "cycle_settle" ? "CS" : "CR", op === "cycle_settle" ? d.settlements : d.containerReturns),
			deliveryId: balance.deliveryId,
			packId: balance.packId,
			customerId: balance.customerId,
			code: balance.code,
			name: balance.name,
			quantity: amount,
			reason: required(b.reason, "السبب")
		};
		if (op === "cycle_settle") {
			d.settlements.push(common);
			description = "تسوية عهدة معتمدة";
		} else {
			if (![
				"ready",
				"cleaning",
				"repair",
				"damaged"
			].includes(b.condition)) throw Error("اختر حالة العبوات المرتجعة");
			const entryId = "CR-" + id;
			d.containerReturns.push({
				...common,
				condition: b.condition,
				entryId
			});
			d.entries.push({
				id: entryId,
				code: balance.code,
				name: balance.name,
				unit: balance.unit,
				category: "packaging",
				warehouse: warehouse(),
				batch: common.number,
				quantity: amount,
				kind: "container-return",
				quality: b.condition === "damaged" ? "R" : "H",
				reason: common.reason,
				at: now,
				by: u.email
			});
			description = "استلام عبوات من العميل";
		}
	}
	if (op === "cycle_container_release") {
		const r = d.containerReturns.find((r) => r.id === b.returnId);
		if (!r || r.releasedAt) throw Error("المرتجع غير متاح لاعتماد الصلاحية");
		if (!["A", "R"].includes(b.decision)) throw Error("اختر A أو R");
		const e = d.entries.find((e) => e.id === r.entryId);
		if (!e) throw Error("الباتش غير موجود");
		Object.assign(r, qualityDisposition(b, r.condition === "damaged" ? ["حالة العبوات المرتجعة تالفة"] : []));
		r.releasedAt = now;
		r.releasedBy = u.email;
		r.releaseReason = required(b.reason, "نتيجة فحص الصلاحية");
		r.decision = b.decision;
		r.condition = b.decision === "A" ? "ready" : "damaged";
		e.quality = b.decision;
		description = "اعتماد صلاحية العبوات المرتجعة";
	}
	d.history.push({
		...base,
		action: description
	});
	tagNewMovements(d, now);
	let guard = "", args = [];
	if (guardOrder) {
		guard += " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND demo=? AND version=?)";
		args.push(guardOrder.id, demo, guardOrder.version);
	}
	if (guardTicket) {
		guard += " AND EXISTS (SELECT 1 FROM tickets WHERE id=? AND version=?)";
		args.push(guardTicket.id, guardTicket.version);
	}
	if (!(inv.version === 0 ? await db.run("INSERT OR IGNORE INTO inventory(id,version,data) SELECT ?,1,? WHERE 1=1" + guard, [
		demo,
		JSON.stringify(d),
		...args
	]) : await db.run("UPDATE inventory SET data=?,version=version+1 WHERE id=? AND version=?" + guard, [
		JSON.stringify(d),
		demo,
		inv.version,
		...args
	])).changes) throw Error("تعارض تحديث الأرصدة أو الأمر؛ حدّث الصفحة وأعد المحاولة");
	return {
		ok: true,
		...op === "cycle_receive" ? await safeAutomaticFilling(db, u, demo, inv.lots.find((l) => l.id === b.lotId)?.category === "semi" ? { sourceLotId: b.lotId } : {}) : {}
	};
}
//#endregion
//#region lib/receiving.ts
function eligibleReceivingOrders(orders, fruitCode) {
	return orders.filter((o) => o.status === "open" && ["Bulk", "PI01"].includes(o.data.type) && (o.data.requirements || []).some((r) => r.code === fruitCode));
}
async function receivingOperation(db, u, b) {
	if (!Number.isInteger(b.id) || !Number.isInteger(b.version)) throw Error("رقم تذكرة غير صالح");
	const row = await db.first("SELECT * FROM tickets WHERE id=?", [b.id]);
	if (!row || row.version !== b.version) throw Error("تم تحديث التذكرة؛ أعد فتحها");
	if (row.status !== "unload") throw Error("هذه العملية متاحة في مرحلة الاستلام والتفريغ فقط");
	const d = JSON.parse(row.data), now = (/* @__PURE__ */ new Date()).toISOString();
	let status = row.status, action = "", order = null;
	if (b.action === "receiving_quality") {
		if (!["admin", "quality"].includes(u.role)) throw Error("تأكيد نسبة الخصم متاح للجودة فقط");
		if (b.confirm !== true || b.deduction === "" || b.deduction == null) throw Error("أدخل نسبة الخصم وأكد مراجعتها");
		const value = Number(b.deduction);
		if (!Number.isFinite(value) || value < 0 || value > 20 || Math.abs(value * 1e3 - Math.round(value * 1e3)) > 1e-5) throw Error("نسبة الخصم يجب أن تكون من صفر إلى 20");
		const reviewerName = String(b.reviewerName || "").trim();
		if (!reviewerName || reviewerName.length > 160) throw Error("أدخل اسم القائم بالتعديل");
		const previous = d.deduction ?? 0, decision = b.decision || "A";
		if (!["A", "R"].includes(decision)) throw Error("اختر قرار الجودة");
		const disposition = qualityDisposition({
			...b,
			decision
		});
		if (decision === "A" && b.allowProceed !== true) throw Error("أكد السماح بانتقال الشحنة للتفريغ");
		if (value !== previous && (!String(b.reason || "").trim() || String(b.reason).length > 160)) throw Error("أدخل سبب تعديل نسبة الخصم");
		if (d.receivingQuality) {
			d.receivingQualityHistory ||= [];
			d.receivingQualityHistory.push(d.receivingQuality);
		}
		d.receivingQuality = {
			schemaVersion: 5,
			...disposition,
			previous,
			deduction: value,
			decision,
			reviewerName,
			allowProceed: decision === "A" && b.allowProceed === true,
			confirmed: true,
			at: now,
			by: u.email
		};
		d.deduction = value;
		if (decision === "R") {
			d.decision = "R";
			d.reason = disposition.reason;
			status = "rejected";
		}
		action = (decision === "R" ? "رفض الشحنة عند الاستلام: " : "تأكيد خصم الاستلام: ") + previous + "% → " + value + "%" + (d.receivingQuality.reason ? " — " + d.receivingQuality.reason : "");
	} else if (b.action === "unload") {
		if (!["admin", "production"].includes(u.role)) throw Error("لا توجد صلاحية لتأكيد التفريغ");
		if (!receivingReady(d)) throw Error("يجب تأكيد نسبة الخصم والسماح بالانتقال بواسطة الجودة قبل التفريغ");
		if (b.confirm !== true) throw Error("أكد إتمام التفريغ");
		if (b.orderId !== "" && b.orderId != null) {
			if (!Number.isSafeInteger(Number(b.orderId)) || Number(b.orderId) < 1) throw Error("اختر أمر تشغيل صالحًا");
			const raw = await db.first("SELECT * FROM production_orders WHERE id=?", [Number(b.orderId)]);
			if (!raw || raw.demo !== row.demo) throw Error("أمر التشغيل غير موجود في نفس سجل التشغيل");
			order = decodeOrder(raw);
			if (!eligibleReceivingOrders([order], d.fruitCode).length) throw Error("أمر التشغيل مغلق أو لا يحتوي المادة الخام للشحنة");
			assertScope(await inventorySnapshot(db, row.demo), u, { lineId: order.data.lineId });
			d.receivingOrderId = order.id;
			d.order = order.number;
		}
		d.pond = String(b.pond || "").trim().slice(0, 160);
		d.unloadBy = u.email;
		d.unloadAt = now;
		status = "empty";
		action = "تأكيد الاستلام والتفريغ" + (order ? " — " + order.number : " — إلى حوض الإنتاج");
	} else throw Error("إجراء غير معروف");
	d.stageShifts = {
		...d.stageShifts || {},
		[b.action]: shiftMetadata(now)
	};
	const history = [...JSON.parse(row.history), {
		at: now,
		by: u.email,
		action,
		...shiftMetadata(now)
	}];
	const guard = order ? " AND EXISTS (SELECT 1 FROM production_orders WHERE id=? AND version=? AND status='open')" : "";
	const args = [
		status,
		JSON.stringify(d),
		JSON.stringify(history),
		row.id,
		b.version
	];
	if (order) args.push(order.id, order.version);
	if (!(await db.run("UPDATE tickets SET status=?,data=?,history=?,version=version+1 WHERE id=? AND version=?" + guard, args)).changes) throw Error("تغيرت التذكرة أو أمر التشغيل؛ أعد فتح التذكرة");
	return { ok: true };
}
//#endregion
//#region lib/workflow.ts
var statuses = {
	quality: "انتظار الجودة",
	gross: "انتظار الوزن القائم",
	unload: "انتظار تأكيد الاستلام",
	assign: "اختيار أمر التشغيل",
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
		"تأكيد الاستلام"
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
		requiresAgriculturalInspection: true,
		requiresWarehouseReceipt: false,
		receivingRoute: "direct-pond-v43",
		arrivalShift: shiftMetadata(now),
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
function transition(row, action, b, role, now) {
	if (role !== "admin" && {
		quality: "quality",
		gross: "scale",
		unload: "production",
		empty: "scale"
	}[action] !== role) throw Error("لا توجد صلاحية لتنفيذ هذا الإجراء");
	if (row.status !== action && !(row.status === "assign" && action === "empty")) throw Error("المرحلة تغيرت أو الإجراء غير متاح");
	const d = { ...row.data };
	let status = "";
	if (action === "quality") {
		{
			const shift = operatingShift(now);
			const q = validateAgriculturalInspection({
				...b,
				inspectionShift: [
					"A",
					"B",
					"C"
				][shift.slot - 1]
			}, now, d);
			Object.assign(q, {
				shiftName: shift.name,
				shiftId: shift.id,
				operatingDay: shift.day
			});
			d.agriculturalQuality = q;
			if (b.approveReceiving === true && b.decision === "A") {
				if (b.allowProceed !== true) throw Error("أكد السماح بمتابعة الاستلام مع اعتماد الخصم");
				d.receivingQuality = {
					schemaVersion: 6,
					source: "combined-inspection",
					previous: d.deduction ?? 0,
					deduction: q.finalDeduction,
					decision: "A",
					reviewerName: q.inspectorName,
					reason: q.reason,
					override: q.override,
					warningAcknowledged: q.warningAcknowledged,
					allowProceed: true,
					confirmed: true,
					at: now,
					inspectionAt: q.approvedAt
				};
			}
			b = {
				...b,
				deduction: q.finalDeduction,
				reason: q.reason
			};
		}
		if (!["A", "R"].includes(b.decision)) throw Error("اختر A أو R");
		d.decision = b.decision;
		d.inspection = d.inspection || documentNumber("inspection", row.id);
		d.deduction = b.deduction === void 0 || b.deduction === null || String(b.deduction).trim() === "" ? 0 : num(b.deduction, "نسبة الخصم", 0, 20);
		d.qualityAt = now;
		d.reason = d.agriculturalQuality?.reason || (b.decision === "R" ? text(b.reason, "سبب الرفض") : "");
		status = b.decision === "R" ? "rejected" : "gross";
	} else if (action === "gross") {
		d.gross = num(b.gross, "الوزن القائم", .001);
		d.grossAt = now;
		status = "unload";
	} else if (action === "unload") {
		if (!receivingReady(d)) throw Error("يجب تأكيد نسبة الخصم والسماح بالانتقال بواسطة الجودة قبل التفريغ");
		if (b.confirm !== true) throw Error("أكد إتمام التفريغ");
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
	d.stageShifts = {
		...d.stageShifts || {},
		[action]: shiftMetadata(now)
	};
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
export { assignTicketOrder, automaticFillingOperation, completeFruitReceipt, controlOperation, createData, createTicketSql, decodeOrder, defaultCatalog, documentNumber, duplicatePlateMessage, groupedInventoryOperation, inventoryOperation, inventorySnapshot, labelBatchChoices, nextOutputBatch, normalizePlate, operatingShift, productionOperation, receivingOperation, roles, scopedOperations, shiftMetadata, stages, statuses, text, transition, validateCatalog, warehouseCycle };
