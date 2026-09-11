/**
 * Synthetic member data. Deliberately fake: no real names, no real account
 * numbers, no real PII. The "SSN" field is a fixed dummy pattern so we can
 * demonstrate redaction without ever handling a real identifier.
 */
export interface Member {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DORMANT' | 'CLOSED';
  branch: string;
  ssnLast4: string;
  accounts: { kind: string; number: string; balance: number }[];
}

export const MEMBERS: Record<string, Member> = {
  '12345': {
    id: '12345',
    name: 'RIVERA, DANA Q',
    status: 'ACTIVE',
    branch: 'EASTGATE 004',
    ssnLast4: '0000',
    accounts: [
      { kind: 'SHARE SAVINGS', number: 'S-0001', balance: 4812.55 },
      { kind: 'SHARE DRAFT', number: 'D-0001', balance: 1290.03 },
    ],
  },
  '23456': {
    id: '23456',
    name: 'OKONKWO, PAT R',
    status: 'ACTIVE',
    branch: 'NORTHFIELD 011',
    ssnLast4: '0000',
    accounts: [{ kind: 'SHARE SAVINGS', number: 'S-0044', balance: 19.20 }],
  },
  // Carries a compliance review flag: reaching this record requires
  // acknowledging an interstitial first. See SPECIAL.INTERSTITIAL.
  '88888': {
    id: '88888',
    name: 'VOSS, ALEX T',
    status: 'ACTIVE',
    branch: 'NORTHFIELD 011',
    ssnLast4: '0000',
    accounts: [{ kind: 'SHARE SAVINGS', number: 'S-0777', balance: 250.00 }],
  },
  '34567': {
    id: '34567',
    name: 'BLANCHARD, LEE',
    status: 'DORMANT',
    branch: 'EASTGATE 004',
    ssnLast4: '0000',
    accounts: [{ kind: 'SHARE SAVINGS', number: 'S-0102', balance: 0 }],
  },
};

/** Member IDs that exercise specific runtime conditions. */
export const SPECIAL = {
  NOT_FOUND: '99999',
  RESTRICTED: '77777',
  INTERSTITIAL: '88888',
} as const;
