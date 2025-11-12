# Admin Dashboard Fix Documentation

## Overview
This document explains the fix for the admin dashboard user list issue where only the logged-in admin user was visible instead of all users and pending approvals.

## Problem
The admin dashboard was not showing:
- The full list of users in the "All Users" tab
- Pending approval users in the "Pending Approvals" tab
- Only the currently logged-in admin user was visible

## Root Cause
The frontend code was querying the `user_profiles` table directly using the Supabase client with the anon key. However, Supabase Row Level Security (RLS) policies only allow users to read their own profile, meaning even admins could only see their own record.

## Solution
Created backend API endpoints that use the Supabase service role key (which bypasses RLS) with proper JWT authentication to verify admin users.

## New Backend Endpoints

All endpoints require authentication via JWT token in the Authorization header and verify the user has the 'admin' role.

### GET /api/admin/users
Fetches all user profiles.

**Authorization:** Bearer token required (admin only)

**Response:**
```json
{
  "users": [
    {
      "user_id": "uuid",
      "email": "user@example.com",
      "name": "User Name",
      "role": "internal_user",
      "requested_role": "internal_user",
      "approval_status": "approved",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### GET /api/admin/users/pending
Fetches users with pending approval status.

**Authorization:** Bearer token required (admin only)

**Response:**
```json
{
  "users": [
    {
      "user_id": "uuid",
      "email": "user@example.com",
      "name": "User Name",
      "role": "external_user",
      "requested_role": "internal_user",
      "approval_status": "pending",
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

### PATCH /api/admin/users/:userId/role
Updates a user's role and sets approval status to 'approved'.

**Authorization:** Bearer token required (admin only)

**Request Body:**
```json
{
  "role": "internal_user"
}
```

**Valid Roles:** `guest`, `external_user`, `internal_user`, `admin`

**Response:**
```json
{
  "user": {
    "user_id": "uuid",
    "email": "user@example.com",
    "role": "internal_user",
    "approval_status": "approved",
    ...
  }
}
```

### PATCH /api/admin/users/:userId/reject
Rejects a user's request by setting approval status to 'rejected'.

**Authorization:** Bearer token required (admin only)

**Response:**
```json
{
  "user": {
    "user_id": "uuid",
    "approval_status": "rejected",
    ...
  }
}
```

## Frontend Changes

The following functions in `public/auth.js` have been updated to call the backend API:

- `getPendingUsers()` - Calls `GET /api/admin/users/pending`
- `getAllUsers()` - Calls `GET /api/admin/users`
- `updateUserRole(userId, newRole)` - Calls `PATCH /api/admin/users/:userId/role`
- `rejectUser(userId)` - Calls `PATCH /api/admin/users/:userId/reject`

All functions:
1. Check if the current user has admin permission
2. Get the JWT token from the current Supabase session
3. Make an authenticated request to the backend API
4. Handle errors appropriately

## Security

### Authentication Flow
1. User signs in to Supabase (gets JWT token)
2. Frontend checks user has 'canAccessAdmin' permission
3. Frontend sends request to backend with JWT in Authorization header
4. Backend middleware (`verifyAdminAuth`) verifies:
   - JWT token is valid
   - User exists in Supabase
   - User has 'admin' role in user_profiles table
5. If authorized, backend uses service role to query/update database
6. Response returned to frontend

### Security Features
- ✅ JWT token verification on all admin endpoints
- ✅ Admin role check in middleware
- ✅ Service role key stays on backend (never exposed to frontend)
- ✅ Proper HTTP status codes (401 Unauthorized, 403 Forbidden, 500 Server Error)
- ✅ Role validation prevents invalid role assignments
- ✅ Error messages don't leak sensitive information

## Testing the Fix

### Prerequisites
- Ensure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE` are configured
- Have at least one admin user in the database
- Have at least one non-admin user for testing

### Test Steps
1. **Sign in as admin user**
   - Navigate to the application
   - Sign in with admin credentials
   
2. **Open admin dashboard**
   - Click the FAB menu (⚡ button)
   - Click the admin button (if you see it, you have admin access)

3. **Verify "All Users" tab**
   - Should show all users in the system
   - Should include users with all roles (guest, external_user, internal_user, admin)
   - Should show current approval status for each user

4. **Verify "Pending Approvals" tab**
   - Should show users with `approval_status = 'pending'`
   - Should show approve and reject buttons
   - Badge should show count of pending users

5. **Test role change**
   - In "All Users" tab, select a different role from dropdown
   - Should update successfully
   - User should appear with new role after refresh

6. **Test user approval**
   - In "Pending Approvals" tab, click "Approve" for a user
   - User should move to approved status
   - Should disappear from pending list after refresh

7. **Test user rejection**
   - In "Pending Approvals" tab, click "Reject" for a user
   - Confirm the rejection
   - User should be rejected
   - Should disappear from pending list after refresh

## Troubleshooting

### Admin dashboard still shows only my user
- Check browser console for errors
- Verify `SUPABASE_SERVICE_ROLE` is set in environment variables
- Ensure your user has `role = 'admin'` in the database
- Try signing out and signing back in
- Clear browser cache

### Getting 401/403 errors
- Verify your JWT token is valid (check browser console)
- Confirm your user has `role = 'admin'` in user_profiles table
- Check server logs for authentication errors

### Changes not reflecting
- The frontend caches data - refresh the admin modal by closing and reopening
- Check browser console for API errors
- Verify database changes are actually being applied

## Migration Notes

### No Database Changes Required
This fix does not require any changes to the database schema or RLS policies. It works with the existing setup by:
- Using service role on backend to bypass RLS
- Adding authentication layer to verify admin users
- Keeping RLS policies for frontend client operations

### Deployment
1. Deploy the updated code to your server
2. Ensure environment variables are set (especially `SUPABASE_SERVICE_ROLE`)
3. No database migration needed
4. Test with admin account
