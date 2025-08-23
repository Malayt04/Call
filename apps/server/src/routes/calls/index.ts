import { Hono } from "hono";
import { z } from "zod";
import { db } from "@call/db";
import {
  calls,
  callInvitations,
  notifications,
  user as userTable,
  callParticipants,
  callJoinRequests,
  hiddenCalls,
} from "@call/db/schema";
import { eq, inArray, desc, and, sql } from "drizzle-orm";
import type { ReqVariables } from "../../index.js";
import { sendMail } from "@call/auth/utils/send-mail";

const callsRoutes = new Hono<{ Variables: ReqVariables }>();

const createCallSchema = z.object({
  name: z.string().min(1),
  members: z.array(z.string().email()).optional(),
  teamId: z.string().optional(),
});

function generateCallCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

callsRoutes.post("/create", async (c) => {
  console.log("🔍 [CALLS DEBUG] POST /create called");

  // Get authenticated user (like teams does)
  const user = c.get("user");
  console.log("👤 [CALLS DEBUG] User:", { id: user?.id, email: user?.email });

  if (!user || !user.id) {
    console.log("❌ [CALLS DEBUG] No user found - returning 401");
    return c.json({ message: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await c.req.json();
    console.log("📝 [CALLS DEBUG] Request body:", body);
  } catch (e) {
    console.error("❌ [CALLS DEBUG] JSON parse error:", e);
    return c.json({ message: "Invalid JSON body" }, 400);
  }

  // Validate input
  const parse = createCallSchema.safeParse(body);
  if (!parse.success) {
    console.log("❌ [CALLS DEBUG] Validation error:", parse.error.errors);
    return c.json(
      { message: parse.error.errors[0]?.message || "Invalid input" },
      400
    );
  }
  const { name, members } = parse.data;
  console.log("✅ [CALLS DEBUG] Validated data:", { name, members });

  // Find users by email (like teams does)
  console.log("🔍 [CALLS DEBUG] Finding users by email:", members);
  const users = await db
    .select()
    .from(userTable)
    .where(inArray(userTable.email, members || []));
  console.log("👥 [CALLS DEBUG] Found users:", users.length);
  const emailToUserId = new Map(users.map((u) => [u.email, u.id]));

  // Generate unique call ID
  console.log("🔑 [CALLS DEBUG] Generating call ID...");
  let callId;
  let exists = true;
  while (exists) {
    callId = generateCallCode();
    const found = await db.select().from(calls).where(eq(calls.id, callId));
    exists = found.length > 0;
  }
  console.log("✅ [CALLS DEBUG] Generated call ID:", callId);

  // Insert call
  console.log("💾 [CALLS DEBUG] Inserting call into database...");
  try {
    await db.insert(calls).values({
      id: callId as string,
      name,
      creatorId: user.id as string,
      createdAt: new Date(),
    });
    console.log("✅ [CALLS DEBUG] Call inserted successfully");
  } catch (error) {
    console.error("❌ [CALLS DEBUG] Error inserting call:", error);
    throw error;
  }

  // Insert invitations and notifications
  console.log("📧 [CALLS DEBUG] Creating invitations and notifications...");
  try {
    for (const email of members || []) {
      const inviteeId = emailToUserId.get(email);
      console.log(
        `📨 [CALLS DEBUG] Processing invitation for ${email}, inviteeId: ${inviteeId}`
      );

      const invitationData: any = {
        id: crypto.randomUUID(),
        callId,
        inviteeEmail: email,
        status: "pending",
        createdAt: new Date(),
      };
      if (inviteeId) invitationData.inviteeId = inviteeId;

      await db.insert(callInvitations).values(invitationData);
      console.log(`✅ [CALLS DEBUG] Invitation created for ${email}`);

      if (inviteeId) {
        const notificationMessage = body.teamId
          ? `${user.name || user.email} started a meeting in team: ${name}`
          : `${user.name || user.email} is inviting you to a call: ${name}`;

        await db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: inviteeId,
          message: notificationMessage,
          type: "call",
          callId,
          createdAt: new Date(),
        });
        console.log(`✅ [CALLS DEBUG] Notification created for ${email}`);

        // Try sending email, but do not fail the whole request if it errors
        try {
          await sendMail({
            to: email,
            subject: "Invitation to join Call",
            text: `Hello,\n\n${user.name || user.email} is inviting you to a call: ${name}\n\nJoin the call: ${process.env.FRONTEND_URL}/calls/${callId}`,
          });
          console.log(`✅ [CALLS DEBUG] Email sent to ${email}`);
        } catch (emailError) {
          console.error(
            `⚠️ [CALLS DEBUG] Failed to send email to ${email}:`,
            emailError
          );
          // Continue without throwing so the call creation succeeds
        }
      }
    }
    console.log("✅ [CALLS DEBUG] All invitations and notifications created");
  } catch (error) {
    console.error(
      "❌ [CALLS DEBUG] Error creating invitations/notifications:",
      error
    );
    throw error;
  }

  console.log("🎉 [CALLS DEBUG] Call created successfully:", callId);
  return c.json({ callId });
});

callsRoutes.patch("/invitations/:id/accept", async (c) => {
  const invitationId = c.req.param("id");
  if (!invitationId) return c.json({ error: "Missing invitation id" }, 400);

  const [invitation] = await db
    .select()
    .from(callInvitations)
    .where(eq(callInvitations.id, invitationId));
  if (!invitation) return c.json({ error: "Invitation not found" }, 404);
  if (invitation.status !== "pending")
    return c.json({ error: "Already handled" }, 400);

  await db
    .update(callInvitations)
    .set({ status: "accepted" })
    .where(eq(callInvitations.id, invitationId));

  return c.json({ callId: invitation.callId });
});

callsRoutes.patch("/invitations/:id/reject", async (c) => {
  const invitationId = c.req.param("id");
  if (!invitationId) return c.json({ error: "Missing invitation id" }, 400);

  const [invitation] = await db
    .select()
    .from(callInvitations)
    .where(eq(callInvitations.id, invitationId));
  if (!invitation) return c.json({ error: "Invitation not found" }, 404);
  if (invitation.status !== "pending")
    return c.json({ error: "Already handled" }, 400);

  await db
    .update(callInvitations)
    .set({ status: "rejected" })
    .where(eq(callInvitations.id, invitationId));

  return c.json({ message: "Invitation rejected" });
});

// GET /api/calls/participated
callsRoutes.get("/participated", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Get all calls where user was a participant with participant details, excluding hidden calls
    const participatedCalls = await db
      .select({
        id: calls.id,
        name: calls.name,
        creatorId: calls.creatorId,
        joinedAt: callParticipants.joinedAt,
        leftAt: callParticipants.leftAt,
      })
      .from(callParticipants)
      .innerJoin(calls, eq(callParticipants.callId, calls.id))
      .leftJoin(
        hiddenCalls,
        and(
          eq(hiddenCalls.callId, calls.id),
          eq(hiddenCalls.userId, user.id as string)
        )
      )
      .where(
        and(
          eq(callParticipants.userId, user.id as string),
          sql`${hiddenCalls.id} IS NULL` // Only show calls that are not hidden
        )
      )
      .orderBy(desc(callParticipants.joinedAt));

    // Get participants for each call
    const callsWithParticipants = await Promise.all(
      participatedCalls.map(async (call) => {
        const participants = await db
          .select({
            id: userTable.id,
            name: userTable.name,
            email: userTable.email,
            image: userTable.image,
            joinedAt: callParticipants.joinedAt,
            leftAt: callParticipants.leftAt,
          })
          .from(callParticipants)
          .innerJoin(userTable, eq(callParticipants.userId, userTable.id))
          .where(eq(callParticipants.callId, call.id));

        return {
          ...call,
          participants,
        };
      })
    );

    return c.json({ calls: callsWithParticipants });
  } catch (error) {
    console.error("Error fetching participated calls:", error);
    return c.json({ error: "Failed to fetch call history" }, 500);
  }
});

// POST /api/calls/record-participation
callsRoutes.post("/record-participation", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json();
    const { callId } = body;

    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    console.log(
      `[RECORD-PARTICIPATION] Recording participation for user ${user.id} in call ${callId}`
    );

    // Check if call exists
    const call = await db.query.calls.findFirst({
      where: eq(calls.id, callId),
    });

    if (!call) {
      return c.json({ error: "Call not found" }, 404);
    }

    // Check if user is already recorded for this call
    const existingParticipation = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, user.id as string)
        )
      )
      .limit(1);

    if (existingParticipation.length === 0) {
      // Record participation only if not already recorded
      const result = await db.insert(callParticipants).values({
        callId,
        userId: user.id as string,
        joinedAt: new Date(),
      });

      console.log(`[RECORD-PARTICIPATION] Insert result:`, result);
    } else {
      console.log(
        `[RECORD-PARTICIPATION] User already has participation record for this call`
      );
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Error recording call participation:", error);
    return c.json({ error: "Failed to record participation" }, 500);
  }
});

// POST /api/calls/record-leave
callsRoutes.post("/record-leave", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let callId;

    // Handle both JSON and beacon requests
    try {
      const body = await c.req.json();
      callId = body.callId;
    } catch (e) {
      // If JSON parsing fails, try to get text (for beacon requests)
      try {
        const text = await c.req.text();
        const parsed = JSON.parse(text);
        callId = parsed.callId;
      } catch (e2) {
        return c.json({ error: "Invalid request body" }, 400);
      }
    }

    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    console.log(
      `[RECORD-LEAVE] Recording leave for user ${user.id} in call ${callId}`
    );

    // Update the leftAt timestamp for the user's participation record
    const result = await db
      .update(callParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, user.id as string)
        )
      );

    console.log(`[RECORD-LEAVE] Update result:`, result);

    return c.json({ success: true });
  } catch (error) {
    console.error("Error recording call leave:", error);
    return c.json({ error: "Failed to record leave time" }, 500);
  }
});

// GET /api/calls/:id/check-access
callsRoutes.get("/:id/check-access", async (c) => {
  try {

    console.log("[CHECK-ACCESS] GET /api/calls/:id/check-access called");
    const callId = c.req.param("id");
    const user = c.get("user");

    if (!user || !user.id) {
      return c.json({ hasAccess: false, isCreator: false }, 200);
    }

    // Check if user is the creator
    const callResult = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!callResult || callResult.length === 0) {
      return c.json({ error: "Call not found" }, 404);
    }

    const call = callResult[0];
    const isCreator = call?.creatorId === user.id;

    if (isCreator) {
      return c.json({ hasAccess: true, isCreator: true }, 200);
    }

    // Check if user has an invitation
    const invitation = await db
      .select()
      .from(callInvitations)
      .where(
        and(
          eq(callInvitations.callId, callId),
          eq(callInvitations.inviteeId, user.id),
          eq(callInvitations.status, "accepted")
        )
      )
      .limit(1);

    // Check if user has an approved join request
    const joinRequest = await db
      .select()
      .from(callJoinRequests)
      .where(
        and(
          eq(callJoinRequests.callId, callId),
          eq(callJoinRequests.requesterId, user.id),
          eq(callJoinRequests.status, "approved")
        )
      )
      .limit(1);

    return c.json(
      {
        hasAccess: invitation.length > 0 || joinRequest.length > 0,
        isCreator: false,
      },
      200
    );
  } catch (error) {
    console.error("Error checking call access:", error);
    return c.json({ error: "Failed to check access" }, 500);
  }
});

// POST /api/calls/:id/request-join
callsRoutes.post("/:id/request-join", async (c) => {
  try {
    const callId = c.req.param("id");
    const user = c.get("user");

    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callResult = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!callResult || callResult.length === 0) {
      return c.json({ error: "Call not found" }, 404);
    }

    const existingRequest = await db
      .select()
      .from(callJoinRequests)
      .where(
        and(
          eq(callJoinRequests.callId, callId),
          eq(callJoinRequests.requesterId, user.id),
          eq(callJoinRequests.status, "pending")
        )
      )
      .limit(1);

    if (existingRequest.length > 0) {
      return c.json({ error: "You already have a pending request" }, 400);
    }

    await db.insert(callJoinRequests).values({
      callId,
      requesterId: user.id,
      status: "pending",
      createdAt: new Date(),
    });

    return c.json({ success: true });
  } catch (error) {
    console.error("Error requesting join:", error);
    return c.json({ error: "Failed to send request" }, 500);
  }
});

// GET /api/calls/:id/join-requests
callsRoutes.get("/:id/join-requests", async (c) => {
  try {
    const callId = c.req.param("id");
    const user = c.get("user");

    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callResult = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!callResult || callResult.length === 0 || !callResult[0]) {
      return c.json({ error: "Call not found" }, 404);
    }

    const call = callResult[0];
    if (call.creatorId !== user.id) {
      return c.json({ error: "Only call creator can view join requests" }, 403);
    }

    const requests = await db
      .select({
        id: callJoinRequests.id,
        userId: userTable.id,
        userName: userTable.name,
        userEmail: userTable.email,
        timestamp: callJoinRequests.createdAt,
      })
      .from(callJoinRequests)
      .innerJoin(userTable, eq(callJoinRequests.requesterId, userTable.id))
      .where(
        and(
          eq(callJoinRequests.callId, callId),
          eq(callJoinRequests.status, "pending")
        )
      )
      .orderBy(desc(callJoinRequests.createdAt));

    return c.json({ requests });
  } catch (error) {
    console.error("Error getting join requests:", error);
    return c.json({ error: "Failed to get requests" }, 500);
  }
});

// POST /api/calls/:id/approve-join
callsRoutes.post("/:id/approve-join", async (c) => {
  try {
    const callId = c.req.param("id");
    const user = c.get("user");
    const body = await c.req.json();
    const { requesterId } = body;

    console.log(
      `[APPROVE-JOIN] Approving join request for user ${requesterId} in call ${callId}`
    );

    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callResult = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!callResult || callResult.length === 0 || !callResult[0]) {
      return c.json({ error: "Call not found" }, 404);
    }

    const call = callResult[0];
    if (call.creatorId !== user.id) {
      return c.json(
        { error: "Only call creator can approve join requests" },
        403
      );
    }

    // Update join request status
    await db
      .update(callJoinRequests)
      .set({ status: "approved" })
      .where(
        and(
          eq(callJoinRequests.callId, callId),
          eq(callJoinRequests.requesterId, requesterId),
          eq(callJoinRequests.status, "pending")
        )
      );

    return c.json({ success: true });
  } catch (error) {
    console.error("Error approving join request:", error);
    return c.json({ error: "Failed to approve request" }, 500);
  }
});

// POST /api/calls/:id/reject-join
callsRoutes.post("/:id/reject-join", async (c) => {
  try {
    const callId = c.req.param("id");
    const user = c.get("user");
    const body = await c.req.json();
    const { requesterId } = body;

    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Check if user is the creator
    const callResult = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!callResult || callResult.length === 0 || !callResult[0]) {
      return c.json({ error: "Call not found" }, 404);
    }

    const call = callResult[0];
    if (call.creatorId !== user.id) {
      return c.json(
        { error: "Only call creator can reject join requests" },
        403
      );
    }

    // Update join request status
    await db
      .update(callJoinRequests)
      .set({ status: "rejected" })
      .where(
        and(
          eq(callJoinRequests.callId, callId),
          eq(callJoinRequests.requesterId, requesterId),
          eq(callJoinRequests.status, "pending")
        )
      );

    return c.json({ success: true });
  } catch (error) {
    console.error("Error rejecting join request:", error);
    return c.json({ error: "Failed to reject request" }, 500);
  }
});

// DELETE /api/calls/participated/:callId
callsRoutes.delete("/participated/:callId", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callId = c.req.param("callId");
    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    console.log(
      `[DELETE-CALL-PARTICIPATION] Deleting participation for user ${user.id} in call ${callId}`
    );

    // Delete the specific participation record
    const result = await db
      .delete(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, user.id as string)
        )
      );

    console.log(`[DELETE-CALL-PARTICIPATION] Delete result:`, result);

    return c.json({
      success: true,
      message: "Call participation deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting call participation:", error);
    return c.json({ error: "Failed to delete call participation" }, 500);
  }
});

// DELETE /api/calls/participated
callsRoutes.delete("/participated", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    console.log(`[DELETE-HISTORY] Deleting call history for user ${user.id}`);

    // Delete all participation records for this user
    const result = await db
      .delete(callParticipants)
      .where(eq(callParticipants.userId, user.id as string));

    console.log(`[DELETE-HISTORY] Delete result:`, result);

    return c.json({
      success: true,
      message: "Call history deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting call history:", error);
    return c.json({ error: "Failed to delete call history" }, 500);
  }
});

// GET /api/calls/:id/participants
callsRoutes.get("/:id/participants", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callId = c.req.param("id");
    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    // Check if the user is a participant in the call
    const participation = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, user.id as string)
        )
      )
      .limit(1);

    if (!participation || participation.length === 0) {
      return c.json({ error: "Call not found or user not a participant" }, 404);
    }

    // Get all participants for this call with their profile information
    const participants = await db
      .select({
        id: userTable.id,
        name: userTable.name,
        email: userTable.email,
        image: userTable.image,
        joinedAt: callParticipants.joinedAt,
        leftAt: callParticipants.leftAt,
      })
      .from(callParticipants)
      .innerJoin(userTable, eq(callParticipants.userId, userTable.id))
      .where(eq(callParticipants.callId, callId));

    // Get call creator info
    const creatorResult = await db
      .select({
        creatorId: calls.creatorId,
        creatorName: userTable.name,
        creatorEmail: userTable.email,
        creatorImage: userTable.image,
      })
      .from(calls)
      .innerJoin(userTable, eq(calls.creatorId, userTable.id))
      .where(eq(calls.id, callId))
      .limit(1);

    if (!creatorResult || creatorResult.length === 0) {
      return c.json({ error: "Call not found" }, 404);
    }

    const creator = creatorResult[0];
    if (!creator) {
      return c.json({ error: "Call creator not found" }, 404);
    }

    // Add creator to participants list if not already present
    const allParticipants = participants.map((participant) => ({
      ...participant,
      isCreator: participant.id === creator.creatorId,
    }));

    // If creator is not in participants list, add them
    if (!allParticipants.find((p) => p.id === creator.creatorId)) {
      allParticipants.push({
        id: creator.creatorId,
        name: creator.creatorName,
        email: creator.creatorEmail,
        image: creator.creatorImage,
        joinedAt: new Date(),
        leftAt: null,
        isCreator: true,
      });
    }

    return c.json({ participants: allParticipants });
  } catch (error) {
    console.error("Error getting call participants:", error);
    return c.json({ error: "Failed to get participants info" }, 500);
  }
});

// POST /api/calls/:id/invite
callsRoutes.post("/:id/invite", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callId = c.req.param("id");
    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    const body = await c.req.json();
    const { email } = body;

    if (!email) {
      return c.json({ error: "Email is required" }, 400);
    }

    // Check if the user is the creator of the call
    const call = await db
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!call || call.length === 0) {
      return c.json({ error: "Call not found" }, 404);
    }

    const callData = call[0];
    if (!callData) {
      return c.json({ error: "Call not found" }, 404);
    }

    if (callData.creatorId !== user.id) {
      return c.json({ error: "Only the call creator can invite users" }, 403);
    }

    // Find the user to invite
    const userToInvite = await db
      .select()
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);

    if (!userToInvite || userToInvite.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }

    const invitee = userToInvite[0];
    if (!invitee) {
      return c.json({ error: "User not found" }, 404);
    }

    // Check if user is already a participant
    const existingParticipation = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, invitee.id)
        )
      )
      .limit(1);

    if (existingParticipation.length > 0) {
      return c.json({ error: "User is already a participant" }, 400);
    }

    // Create invitation
    await db.insert(callInvitations).values({
      callId,
      inviteeId: invitee.id,
      inviteeEmail: email,
      status: "pending",
    });

    // Send notification to the invited user
    await db.insert(notifications).values({
      userId: invitee.id,
      type: "call",
      message: `${user.name || user.email} invited you to join a call`,
      callId,
    });

    return c.json({ success: true, message: "Invitation sent successfully" });
  } catch (error) {
    console.error("Error sending call invitation:", error);
    return c.json({ error: "Failed to send invitation" }, 500);
  }
});

// GET /api/calls/:id/creator
callsRoutes.get("/:id/creator", async (c) => {
  try {
    const callId = c.req.param("id");

    // Get call creator info
    const result = await db
      .select({
        creatorId: calls.creatorId,
        creatorName: userTable.name,
        creatorEmail: userTable.email,
      })
      .from(calls)
      .innerJoin(userTable, eq(calls.creatorId, userTable.id))
      .where(eq(calls.id, callId))
      .limit(1);

    if (!result || result.length === 0) {
      return c.json({ error: "Call not found" }, 404);
    }

    return c.json({ creator: result[0] });
  } catch (error) {
    console.error("Error getting call creator:", error);
    return c.json({ error: "Failed to get creator info" }, 500);
  }
});

// POST /api/calls/:id/hide
callsRoutes.post("/:id/hide", async (c) => {
  try {
    const user = c.get("user");
    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const callId = c.req.param("id");
    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    // Check if the user is a participant in the call
    const participation = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, user.id as string)
        )
      )
      .limit(1);

    if (!participation || participation.length === 0) {
      return c.json({ error: "Call not found or user not a participant" }, 404);
    }

    // Hide the call for this user
    await db.insert(hiddenCalls).values({
      callId,
      userId: user.id as string,
    });

    return c.json({ success: true, message: "Call hidden successfully" });
  } catch (error: unknown) {
    console.error("Error hiding call:", error);
    // If the error is due to the call already being hidden, return success
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      // PostgreSQL unique violation error code
      return c.json({ success: true, message: "Call already hidden" });
    }
    return c.json({ error: "Failed to hide call" }, 500);
  }
});

// POST /api/calls/:id/kick - Remove a participant from call
callsRoutes.post("/:id/kick", async (c) => {
  try {
    const callId = c.req.param("id");
    const user = c.get("user");

    if (!user || !user.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!callId) {
      return c.json({ error: "Call ID is required" }, 400);
    }

    const body = await c.req.json();
    const { userId } = body;

    if (!userId) {
      return c.json({ error: "User ID is required" }, 400);
    }

    // Check if the current user is the creator of the call
    const call = await db
      .select({ creatorId: calls.creatorId })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (!call || call.length === 0 || !call[0]) {
      return c.json({ error: "Call not found" }, 404);
    }

    const callData = call[0];
    if (callData.creatorId !== user.id) {
      return c.json(
        { error: "Only the call creator can remove participants" },
        403
      );
    }

    // Prevent creator from kicking themselves
    if (userId === user.id) {
      return c.json(
        { error: "Call creator cannot remove themselves from the call" },
        400
      );
    }

    // Remove the participant from the call
    const result = await db
      .delete(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, callId),
          eq(callParticipants.userId, userId)
        )
      );

    console.log(
      `[KICK-PARTICIPANT] Removed user ${userId} from call ${callId}`
    );

    // Trigger WebSocket kick event through mediasoup server
    // This will notify the kicked user to disconnect and show them a message
    try {
      // Here we would typically have access to the WebSocket connection
      // or a way to communicate with the mediasoup server to send the kick event
      // For now, we'll rely on the frontend to handle the WebSocket integration
      console.log(
        `[KICK-PARTICIPANT] WebSocket kick notification should be sent to user ${userId}`
      );
    } catch (wsError) {
      console.error("Error sending WebSocket kick notification:", wsError);
      // Don't fail the API call if WebSocket notification fails
    }

    return c.json({
      success: true,
      message: "Participant removed successfully",
    });
  } catch (error) {
    console.error("Error kicking participant:", error);
    return c.json({ error: "Failed to remove participant" }, 500);
  }
});

export default callsRoutes;
