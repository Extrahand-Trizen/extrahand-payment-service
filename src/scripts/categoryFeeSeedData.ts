export type CategoryFeeMode = 'BOOK_NOW' | 'BIDDING';

export type CategoryFeeSeedRow = {
  categoryKey: string;
  mode: CategoryFeeMode;
  displayName: string;
  sacCode?: string;
  sacHeading?: string;
  gstPercentage: number;
};

const CLEANING_SAC = { sacCode: '9985', sacHeading: 'Cleaning Services' } as const;
const REPAIR_SAC = { sacCode: '9987', sacHeading: 'Maintenance & Repair Services' } as const;
const APPLIANCE_SAC = {
  sacCode: '998715',
  sacHeading: 'Electrical Household Appliances',
} as const;
const MOTOR_VEHICLE_SAC = {
  sacCode: '998714',
  sacHeading: 'Maintenance and Repair of Motor Vehicles',
} as const;
const CONSTRUCTION_SAC = {
  sacCode: '995412',
  sacHeading: 'General Construction Services of Civil Engineering Works',
} as const;
const ELECTRICAL_INSTALL_SAC = {
  sacCode: '995461',
  sacHeading: 'Electrical Installation Services',
} as const;
const BEAUTY_SAC = { sacCode: '999722', sacHeading: 'Beauty Treatment Services' } as const;
const EDUCATION_SAC = {
  sacCode: '999293',
  sacHeading: 'Other Education & Training Services',
} as const;
const ACCOUNTING_SAC = { sacCode: '998611', sacHeading: 'Accounting Services' } as const;
const MARKETING_SAC = { sacCode: '998313', sacHeading: 'Advertising Services' } as const;
const PET_SAC = { sacCode: '999899', sacHeading: 'Other Services n.e.c.' } as const;
const FURNITURE_REPAIR_SAC = {
  sacCode: '998725',
  sacHeading: 'Repair Services of Household Goods',
} as const;
const MISC_SAC = { sacCode: '998799', sacHeading: 'Other Miscellaneous Services' } as const;

/** Known SAC mappings for bidding categories (kebab-case keys from APP_CATEGORIES). */
const BIDDING_SAC_BY_KEY: Record<string, { sacCode: string; sacHeading: string }> = {
  accounting: ACCOUNTING_SAC,
  'marketing-design': MARKETING_SAC,
  'home-cleaning': CLEANING_SAC,
  'deep-cleaning': CLEANING_SAC,
  electrical: ELECTRICAL_INSTALL_SAC,
  painting: CONSTRUCTION_SAC,
  'ac-repair': REPAIR_SAC,
  'appliance-repair': APPLIANCE_SAC,
  'car-washing': MOTOR_VEHICLE_SAC,
  'furniture-assembly': MISC_SAC,
  'beauty-services': BEAUTY_SAC,
  'massage-spa': { sacCode: '999723', sacHeading: 'Physical Well-being Services' },
  tutors: EDUCATION_SAC,
  'pet-services': PET_SAC,
  'auto-electricians': MOTOR_VEHICLE_SAC,
  'bicycle-services': {
    sacCode: '998713',
    sacHeading: 'Maintenance and Repair of Transport Equipment',
  },
  'bricklaying-services': {
    sacCode: '995411',
    sacHeading: 'Construction Services of Buildings',
  },
  'flooring-services': CONSTRUCTION_SAC,
  'gate-installation': CONSTRUCTION_SAC,
  decking: CONSTRUCTION_SAC,
  'building-construction': CONSTRUCTION_SAC,
};

function bookNowRow(
  categoryKey: string,
  displayName: string,
  gstPercentage = 0.18,
  sac?: { sacCode: string; sacHeading: string },
): CategoryFeeSeedRow {
  return { categoryKey, mode: 'BOOK_NOW', displayName, gstPercentage, ...sac };
}

function biddingRow(
  categoryKey: string,
  displayName: string,
  gstPercentage = 0.18,
): CategoryFeeSeedRow {
  const sac = BIDDING_SAC_BY_KEY[categoryKey];
  return {
    categoryKey,
    mode: 'BIDDING',
    displayName,
    gstPercentage: categoryKey === 'massage-spa' ? 0.05 : gstPercentage,
    ...sac,
  };
}

/** Book Now catalog slugs — aligned with task-service `book-now-catalog-seed-data.json`. */
export const BOOK_NOW_CATEGORY_FEE_SEED_ROWS: CategoryFeeSeedRow[] = [
  bookNowRow('default', 'Default (Book Now)'),
  bookNowRow('full-house', 'Full House Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('bathroom', 'Bathroom Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('kitchen', 'Kitchen Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('sofa', 'Sofa Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('mattress', 'Mattress Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('window-glass', 'Window & Glass Cleaning', 0.18, CLEANING_SAC),
  bookNowRow('ac-services', 'AC Services', 0.18, REPAIR_SAC),
  bookNowRow('appliance-repair', 'Appliance Repair', 0.18, APPLIANCE_SAC),
];

/**
 * Bidding categories — aligned with ADPT4EH `APP_CATEGORIES` ids (kebab-case)
 * plus platform specials (`hourly-based`, `instant-based`).
 */
const BIDDING_APP_CATEGORIES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'accounting', name: 'Accounting' },
  { id: 'business-services', name: 'Business Services' },
  { id: 'marketing-design', name: 'Marketing & Design' },
  { id: 'home-cleaning', name: 'Home Cleaning' },
  { id: 'deep-cleaning', name: 'Deep Cleaning' },
  { id: 'plumbing', name: 'Plumbing' },
  { id: 'electrical', name: 'Electrician' },
  { id: 'carpenter', name: 'Carpentry' },
  { id: 'painting', name: 'Home Painting' },
  { id: 'ac-repair', name: 'AC Repair & Service' },
  { id: 'appliance-repair', name: 'Appliance Repair' },
  { id: 'pest-control', name: 'Pest Control' },
  { id: 'car-washing', name: 'Car Washing / Car Cleaning' },
  { id: 'packers-movers', name: 'Packers & Movers' },
  { id: 'delivery-pickup-services', name: 'Delivery / Pickup' },
  { id: 'gardening', name: 'Gardening' },
  { id: 'handyperson', name: 'Handyperson / General Repairs' },
  { id: 'furniture-assembly', name: 'Furniture Assembly' },
  { id: 'security-patrol', name: 'Security Patrol / Watchman' },
  { id: 'beauty-services', name: 'Beauty Services' },
  { id: 'massage-spa', name: 'Massage / Spa' },
  { id: 'fitness-trainers', name: 'Fitness Trainers' },
  { id: 'senior-care-elder-care', name: 'Senior Care / Elder Care' },
  { id: 'tutors', name: 'Tutors' },
  { id: 'it-support', name: 'IT Support / Laptop Repair' },
  { id: 'photographer-videographer', name: 'Photographer / Videographer' },
  { id: 'event-services', name: 'Event Services' },
  { id: 'pet-services', name: 'Pet Services' },
  { id: 'driver-chauffeur', name: 'Driver / Chauffeur' },
  { id: 'cooking-home-chef', name: 'Cooking / Home Chef' },
  { id: 'laundry-ironing', name: 'Laundry / Ironing' },
  { id: 'water-tanker-services', name: 'Water & Tanker Services' },
  { id: 'admin-office-services', name: 'Admin / Office Services' },
  { id: 'alteration-services', name: 'Alteration Services' },
  { id: 'interior-architecture', name: 'Interior & Architecture' },
  { id: 'bakers-services', name: 'Bakers Services' },
  { id: 'building-construction', name: 'Building & Construction' },
  { id: 'writing-services', name: 'Writing Services' },
  { id: 'auto-electricians', name: 'Auto Electricians' },
  { id: 'av-specialist', name: 'AV Specialist' },
  { id: 'assembly-services', name: 'Assembly Services' },
  { id: 'bicycle-services', name: 'Bicycle Services' },
  { id: 'bricklaying-services', name: 'Bricklaying Services' },
  { id: 'decking', name: 'Decking' },
  { id: 'florist', name: 'Florist' },
  { id: 'flooring-services', name: 'Flooring Services' },
  { id: 'draftsman', name: 'Draftsman' },
  { id: 'gate-installation', name: 'Gate Installation' },
  { id: 'home-automation', name: 'Home Automation' },
  { id: 'home-theatre-services', name: 'Home Theatre Services' },
  { id: 'receptionist-services', name: 'Receptionist Services' },
  { id: 'sharpening-services', name: 'Sharpening Services' },
  { id: 'other', name: 'Other' },
];

export const BIDDING_CATEGORY_FEE_SEED_ROWS: CategoryFeeSeedRow[] = [
  biddingRow('default', 'Default (Bidding)'),
  ...BIDDING_APP_CATEGORIES.map(({ id, name }) => biddingRow(id, name)),
  biddingRow('hourly-based', 'Book a Helper (Hourly)'),
  biddingRow('instant-based', 'Instant Helper (Coming Soon)'),
];

/** Canonical seed rows — used when DB is empty or Excel is unavailable. */
export const CATEGORY_FEE_SEED_ROWS: CategoryFeeSeedRow[] = [
  ...BOOK_NOW_CATEGORY_FEE_SEED_ROWS,
  ...BIDDING_CATEGORY_FEE_SEED_ROWS,
];
