import type { DatasetRow, LookupApiResponse, ProfileFlatFields, ProfileResult } from './types.js';

function joinList(values?: string[]): string {
    return (values || []).filter(Boolean).join('; ');
}

function jsonString(value: unknown): string {
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

function boolString(value: boolean | undefined): string {
    if (value === undefined) return '';
    return value ? 'true' : 'false';
}

function sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_]/g, '_');
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function flattenObject(
    input: unknown,
    prefix = 'profile',
    out: Record<string, string | number | boolean> = {},
    depth = 0,
): Record<string, string | number | boolean> {
    if (depth > 7) return out;
    if (isPrimitive(input)) {
        out[prefix] = input ?? '';
        return out;
    }

    if (Array.isArray(input)) {
        out[prefix] = jsonString(input);
        return out;
    }

    if (!input || typeof input !== 'object') return out;

    for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
        const key = `${prefix}_${sanitizeKey(rawKey)}`;
        if (isPrimitive(rawVal)) {
            out[key] = rawVal ?? '';
            continue;
        }
        if (Array.isArray(rawVal)) {
            out[key] = jsonString(rawVal);
            continue;
        }
        flattenObject(rawVal, key, out, depth + 1);
    }

    return out;
}

function emptyRow(): ProfileFlatFields {
    return {
        profileId: '',
        fullName: '',
        firstName: '',
        lastName: '',
        headline: '',
        summary: '',
        linkedinUrl: '',
        pictureUrl: '',
        company: '',
        location: '',
        isPublic: '',
        localeCountry: '',
        localeLanguage: '',
        educationsCount: 0,
        positionsCount: 0,
        skillsCount: 0,
        skills: '',
        educationHistory: '',
        positionHistory: '',
        profileRawJson: '',
        profileFlattenedJson: '',
    };
}

function profileToFields(
    profile: ProfileResult | null | undefined,
): ProfileFlatFields {
    if (!profile) return emptyRow();

    const educationHistory = profile.schools?.educationHistory ?? [];
    const positionHistory = profile.positions?.positionHistory ?? [];
    const skills = profile.skills ?? [];

    return {
        ...flattenObject(profile),
        profileId: profile.profileId || profile.id || '',
        fullName: profile.displayName || '',
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        headline: profile.headline || '',
        summary: profile.summary || '',
        linkedinUrl: profile.profileUrl || '',
        pictureUrl: profile.pictureUrl || '',
        company: profile.company || '',
        location: profile.location || '',
        isPublic: boolString(profile.isPublic),
        localeCountry: profile.locale?.country || '',
        localeLanguage: profile.locale?.language || '',
        educationsCount: profile.educationsCount ?? profile.schools?.educationsCount ?? educationHistory.length,
        positionsCount: profile.positionsCount ?? profile.positions?.positionsCount ?? positionHistory.length,
        skillsCount: profile.skillsCount ?? skills.length,
        skills: joinList(skills),
        educationHistory: jsonString(educationHistory),
        positionHistory: jsonString(positionHistory),
        profileRawJson: jsonString(profile),
        profileFlattenedJson: jsonString(flattenObject(profile)),
    };
}

export function toDatasetRow(email: string, result: LookupApiResponse): DatasetRow {
    const profile = result.success ? result.profile : null;
    const fields = profileToFields(profile);

    if (result.success) {
        return {
            email: result.email,
            hasLinkedIn: result.hasLinkedIn,
            matchType: result.matchType || (result.hasLinkedIn ? 'exact' : 'none'),
            method: result.method || 'deep-v2',
            ...fields,
            checkedAt: result.checkedAt,
            success: true,
            error: '',
            statusCode: 200,
        };
    }

    return {
        email: result.email || email,
        hasLinkedIn: false,
        matchType: 'none',
        method: result.method || 'deep-v2',
        ...emptyRow(),
        checkedAt: '',
        success: false,
        error: result.error || 'Lookup failed',
        statusCode: result.statusCode ?? null,
    };
}

export function errorDatasetRow(email: string, message: string): DatasetRow {
    return {
        email,
        hasLinkedIn: false,
        matchType: 'none',
        method: 'deep-v2',
        ...emptyRow(),
        checkedAt: '',
        success: false,
        error: message,
        statusCode: null,
    };
}
