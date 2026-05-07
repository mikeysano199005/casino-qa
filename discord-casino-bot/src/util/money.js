// All money is BIGINT paise. UI shows ₹ rupees with 2 decimals.
export const toPaise  = (rupees) => BigInt(Math.round(Number(rupees) * 100));
export const toRupees = (paise)  => (Number(paise) / 100).toFixed(2);
export const fmt      = (paise)  => `₹${toRupees(paise)}`;
