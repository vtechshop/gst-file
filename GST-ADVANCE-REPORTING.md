# Goods advances in GSTR-1 — an open question for a GST practitioner

**Status: unresolved. No reporting logic has been changed.**

This note exists because the Receipt Voucher now records whether an advance is
for goods or for services, and that distinction has a consequence in GSTR-1
that we have deliberately *not* acted on. It needs a practitioner's answer
before any return-generation code is touched.

Nothing in `client/js/gst/` was modified. What follows is a description of
current behaviour, measured by running the real functions.

---

## 1. The statutory position as we understand it

| | Goods | Services |
|---|---|---|
| Receipt voucher required on advance | Yes — s.31(3)(d), Rule 50 | Yes — s.31(3)(d), Rule 50 |
| Tax payable when the advance is received | **No** — Notification 66/2017-Central Tax, 15 Nov 2017 | Yes — s.13(2) |
| Tax payable when | Invoice is issued | Receipt of advance |

Notification 66/2017 reaches *"a registered person who did not opt for the
composition levy"*. The application now gates on this: see
`voucherAdvanceReliefStatus()` in `client/js/pages/vouchers.js`. A composition
taxpayer is **not** given the relief, and the application does not attempt to
decide what is correct for them instead.

## 2. What the code does today

### Where a receipt voucher becomes a Table 11A row

```
client/js/gst/gstr1-export.js
  └─ (≈ line 2640) at = gstr1BuildAdvanceSection(
         datedDocumentRows.filter(r => r.__documentType === 'receipt_voucher'),
         r => round2(r.advance_amount),      // ad_amt
         r => r.place_of_supply,             // pos  (state name → code)
         r => r.supply_type,                 // sply_ty  INTER / INTRA
         errors, 'Receipt voucher')
  └─ gstr1BuildAdvanceSection()  (≈ line 863)
         buckets by `pos|sply_ty|gst_percentage`
         sums the voucher's STORED igst / cgst / sgst / cess
         skips a row only when the AMOUNT is zero — never when the TAX is zero
```

The builder knows nothing about `supply_nature` and nothing about
Notification 66/2017. It reports whatever tax the voucher carries.

### The measured output for a goods advance

A ₹30,000 goods advance, intrastate, Tamil Nadu, no tax charged, run through
the real `gstr1BuildAdvanceSection`:

```json
[{"pos":"33","sply_ty":"INTRA",
  "itms":[{"rt":0,"ad_amt":30000,"iamt":0,"camt":0,"samt":0,"csamt":0}]}]
```

The same advance treated as services at 18%:

```json
[{"pos":"33","sply_ty":"INTRA",
  "itms":[{"rt":18,"ad_amt":30000,"iamt":0,"camt":2700,"samt":2700,"csamt":0}]}]
```

## 3. The question

Table 11A is *"Advances received for which invoice has not been issued (tax
amount to be added to output tax liability)"*. A goods advance under
Notification 66/2017 adds **nothing** to output tax liability.

So one of these is right, and we do not know which:

1. **Omit it.** A goods advance has no 11A liability, so it should not appear
   in 11A at all. The current 0% row would then be a spurious declaration.
2. **Report it at 0%.** The row is harmless because the tax columns are nil,
   and the portal reads it as an advance with no liability.
3. **Report it somewhere else**, or not at all in GSTR-1, with the advance
   surfacing only in Table 13 (Documents Issued), where the receipt voucher
   already appears by its own serial range.

A 0% row is not neutral in one respect: `rt: 0` is also how a genuinely
nil-rated advance would be expressed. The payload cannot distinguish
*"no tax is due yet"* from *"the rate is nil"*.

### Direction of the change so far

Worth being explicit, because it affects urgency:

* **Before** this feature, a goods advance was reported at the full rate with
  real tax — e.g. ₹5,400 on ₹30,000 at 18% — **overstating** output liability.
* **After**, the liability is nil and correct; what remains is a 0% row whose
  representation is in question.

So the current state is an improvement on the previous one. The open question
is about presentation, not about an understated liability.

## 4. The missing Table 11B reconciliation

`client/js/gst/gstr1-export.js` builds Table 11B (`txpd`) from the
`advance_adjustments` table, using the same function:

```
txpd = gstr1BuildAdvanceSection(advanceAdjustmentRows,
         r => round2(r.adjusted_amount), …, 'Advance adjustment')
```

**Nothing in the voucher flow ever writes `advance_adjustments`.** Confirmed:
`client/js/pages/vouchers.js` contains no insert or update against that table,
and `receipt_vouchers.adjusted_amount` carries a schema comment saying as much
("The Advance module (11A / 11B) will maintain it; nothing writes it yet").

Consequences:

* An 11A row — at any rate — never receives a matching 11B adjustment when the
  invoice is finally raised. It stays open indefinitely.
* For a **services** advance this is a real reconciliation gap: tax was paid in
  11A and is never shown as adjusted in 11B.
* For a **goods** advance it is moot under reading (1) and a loose end under
  reading (2).

This gap is **pre-existing** and not caused by the goods/services work. It is
listed here because any decision about 11A has to account for it.

## 5. Exact files and functions involved

| Concern | File | Function / line |
|---|---|---|
| 11A built from receipt vouchers | `client/js/gst/gstr1-export.js` | `gstr1BuildAdvanceSection`, call site ≈ 2640 |
| 11B built from adjustments | `client/js/gst/gstr1-export.js` | same function, `txpd` ≈ 2646 |
| Adjustment rows fetched | `client/js/gst/gstr1-export.js` | `gstr1FetchAdvanceAdjustments` ≈ 927 |
| Section declarations (`at`, `txpd`) | `client/js/gst/gstr1-export.js` | ≈ 177, 190 |
| Registry treatment for the document type | `client/js/utilities/utils.js` | registry entry `key: 'receipt_voucher'` — `affectsLiability: true`, sections GSTR-1 11A / 13, GSTR-3B 3.1(a), GSTR-9 4F |
| Goods / services decision | `client/js/pages/vouchers.js` | `voucherSupplyNature`, `voucherAdvanceReliefStatus`, `voucherAmounts` |
| Stored classification | `server/db/migrations/migration_receipt_voucher_order.sql` | `supply_nature` |
| 3B carry-through | `client/js/gst/gstr3b.js` | reads the same stored tax |

## 6. What needs confirming

1. Should a Notification 66/2017 goods advance appear in **Table 11A** at all?
   If not, the filter at the call site is the single place to change.
2. If it should appear, is `rt: 0` the correct representation, or does the
   portal expect the applicable rate with nil tax amounts?
3. Does the **registry** entry need qualifying? It currently declares
   `affectsLiability: true` for every receipt voucher, which is now untrue for
   a goods advance. Changing it alters reported treatment for the document type
   generally, so it was left alone.
4. **Table 11B**: should raising an invoice against an advance write an
   `advance_adjustments` row? For services this looks necessary for
   reconciliation. For goods it depends on answer (1).
5. **Composition taxpayers**: the application now declines to apply the relief
   and declines to guess an alternative. What *is* correct for a composition
   dealer receiving an advance, and should the Receipt Voucher offer it at all?
6. Current **CBIC FAQ and GST Portal Table 11A guidance** have not been checked
   against this implementation. That verification was not performed and is
   part of what needs confirming.

## 7. Rule 50 particulars — current state

The receipt PDF (`client/js/pages/receipt-pdf.js`) prints: supplier name,
address and GSTIN; voucher serial number and date; recipient name, **address**
and GSTIN; description; amount of advance; **applicable GST rate** and **GST on
this advance** as separate lines, with `Nil` where no tax is charged; place of
supply; **reverse-charge indication**; and the authorised signature. It is
headed `ADVANCE RECEIPT` and never `TAX INVOICE`. The amount in words is of the
money actually received.

---

*No GSTR-1, GSTR-3B or registry logic may change on the strength of this note
alone. It is a description of current behaviour and a list of questions.*
