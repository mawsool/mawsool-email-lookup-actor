export interface ActorInput {
    emails?: string[];
    emailsCsv?: string;
    fileUrl?: string;
    maxEmails?: number;
    concurrency?: number;
    resumeId?: string;
    freshStart?: boolean;
}

export interface ProfileLocale {
    country?: string;
    language?: string;
}

export interface ProfileSchools {
    educationsCount?: number;
    educationHistory?: unknown[];
}

export interface ProfilePositions {
    positionsCount?: number;
    positionHistory?: unknown[];
}

/** Full profile object returned by Mawsool deep-v2 API on exact match. */
export interface ProfileResult {
    id?: string;
    profileId?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    headline?: string;
    summary?: string;
    profileUrl?: string;
    pictureUrl?: string;
    isPublic?: boolean;
    locale?: ProfileLocale;
    company?: string;
    location?: string;
    educationsCount?: number;
    positionsCount?: number;
    skillsCount?: number;
    skills?: string[];
    schools?: ProfileSchools;
    positions?: ProfilePositions;
}

export interface LookupSuccessResponse {
    success: true;
    method: string;
    email: string;
    hasLinkedIn: boolean;
    matchType?: string;
    profile: ProfileResult | null;
    checkedAt: string;
}

export interface LookupErrorResponse {
    success: false;
    method: string;
    email: string;
    error: string;
    statusCode?: number;
}

export type LookupApiResponse = LookupSuccessResponse | LookupErrorResponse;

export interface ProfileFlatFields {
    profileId: string;
    fullName: string;
    firstName: string;
    lastName: string;
    headline: string;
    summary: string;
    linkedinUrl: string;
    pictureUrl: string;
    company: string;
    location: string;
    isPublic: string;
    localeCountry: string;
    localeLanguage: string;
    educationsCount: number;
    positionsCount: number;
    skillsCount: number;
    skills: string;
    educationHistory: string;
    positionHistory: string;
    profileRawJson: string;
    profileFlattenedJson: string;
}

/** Flat dataset row — all API fields, CSV/Excel friendly. */
export interface DatasetRow extends ProfileFlatFields {
    [key: string]: string | number | boolean | null;
    email: string;
    hasLinkedIn: boolean;
    matchType: string;
    method: string;
    checkedAt: string;
    success: boolean;
    error: string;
    statusCode: number | null;
}
