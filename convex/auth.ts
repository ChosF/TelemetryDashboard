import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Convex Auth configuration
 * 
 * This replaces Supabase Auth completely.
 * Uses email/password authentication with extensible provider support.
 */
export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    Password({
      // Password validation
      profile(params) {
        return {
          email: params.email as string,
          name: params.name as string | undefined,
        };
      },
    }),
  ],
});
