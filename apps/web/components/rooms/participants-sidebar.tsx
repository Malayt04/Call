"use client";

import { Badge } from "@call/ui/components/badge";
import { Button } from "@call/ui/components/button";
import { Separator } from "@call/ui/components/separator";
import { UserProfile } from "@call/ui/components/use-profile";
import { Input } from "@call/ui/components/input";
import { useEffect, useRef, useState } from "react";
import {
  FiCheck,
  FiClock,
  FiMic,
  FiMicOff,
  FiUserPlus,
  FiUsers,
  FiVideo,
  FiVideoOff,
  FiX,
  FiSearch,
  FiMail,
  FiPhone,
  FiUserX,
} from "react-icons/fi";
import { toast } from "sonner";
import { CALLS_QUERY } from "@/lib/QUERIES";
interface Participant {
  id: string;
  displayName?: string;
  name?: string;
  image?: string;
  isCreator?: boolean;
  isMicOn?: boolean;
  isCameraOn?: boolean;
  connectionState?: string;
}

interface Contact {
  id: string;
  name?: string;
  email: string;
  image?: string;
}

interface JoinRequest {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  timestamp: Date;
}

interface ParticipantsSidebarProps {
  callId: string;
  isCreator: boolean;
  participants: Participant[];
  currentUserId: string;
  socket?: WebSocket | null;
}

export function ParticipantsSidebar({
  callId,
  isCreator,
  participants,
  currentUserId,
  socket,
}: ParticipantsSidebarProps) {
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [invitingContact, setInvitingContact] = useState<string | null>(null);
  const [kickingParticipant, setKickingParticipant] = useState<string | null>(null);
  const previousJoinRequestsRef = useRef<JoinRequest[]>([]);

  const creator = participants.find((p) => p.isCreator);

  // Fetch contacts
  useEffect(() => {
    const fetchContacts = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/contacts`,
          {
            credentials: "include",
          }
        );
        if (response.ok) {
          const data = await response.json();
          setContacts(data.contacts || []);
        }
      } catch (error) {
        console.error("Error fetching contacts:", error);
      }
    };

    fetchContacts();
  }, []);

  useEffect(() => {
    if (!isCreator) return;

    const fetchJoinRequests = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/calls/${callId}/join-requests`,
          {
            credentials: "include",
          }
        );

        if (response.ok) {
          const data = await response.json();
          const newJoinRequests = data.requests || [];

          const previousIds = new Set(
            previousJoinRequestsRef.current.map((req: JoinRequest) => req.id)
          );
          const newRequests = newJoinRequests.filter(
            (req: JoinRequest) => !previousIds.has(req.id)
          );

          previousJoinRequestsRef.current = newJoinRequests;
          setJoinRequests(newJoinRequests);
        }
      } catch (error) {
        console.error("Error fetching join requests:", error);
      }
    };

    fetchJoinRequests();

    const interval = setInterval(fetchJoinRequests, 5000);
    return () => clearInterval(interval);
  }, [callId, isCreator, open]);

  const handleApproveRequest = async (userId: string) => {
    setLoading(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/calls/${callId}/approve-join`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ requesterId: userId }),
        }
      );

      if (response.ok) {
        setJoinRequests((prev) => prev.filter((req) => req.userId !== userId));
      } else {
        const data = await response.json();

        toast.error(data.error || "Failed to approve request");
      }
    } catch (error) {
      console.error("Error approving request:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRejectRequest = async (userId: string) => {
    setLoading(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/calls/${callId}/reject-join`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ requesterId: userId }),
        }
      );

      if (response.ok) {
        setJoinRequests((prev) => prev.filter((req) => req.userId !== userId));
      } else {
        const data = await response.json();

        toast.error(data.error || "Failed to reject request");
      }
    } catch (error) {
      console.error("Error rejecting request:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleInviteContact = async (contactEmail: string) => {
    setInvitingContact(contactEmail);
    try {
      await CALLS_QUERY.inviteToCall(callId, contactEmail);
      toast.success(`Invitation sent to ${contactEmail}`);
    } catch (error) {
      console.error("Error inviting contact:", error);
      toast.error("Failed to send invitation");
    } finally {
      setInvitingContact(null);
    }
  };

  const handleKickParticipant = async (userId: string, displayName: string) => {
    if (!isCreator) {
      toast.error("Only the call creator can remove participants");
      return;
    }

    if (userId === currentUserId) {
      toast.error("You cannot remove yourself from the call");
      return;
    }

    setKickingParticipant(userId);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/calls/${callId}/kick`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ userId }),
        }
      );

      if (response.ok) {
        toast.success(`${displayName} has been removed from the call`);
        
        // Send WebSocket message to kick the participant
        if (socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({
              type: "kickParticipant",
              targetPeerId: userId,
              callId: callId,
              reqId: crypto.randomUUID(),
            }));
            console.log(`[KICK] Sent WebSocket kick message for user ${userId}`);
          } catch (wsError) {
            console.error("Error sending WebSocket kick message:", wsError);
          }
        }
      } else {
        const data = await response.json();
        toast.error(data.error || "Failed to remove participant");
      }
    } catch (error) {
      console.error("Error kicking participant:", error);
      toast.error("Failed to remove participant");
    } finally {
      setKickingParticipant(null);
    }
  };

  // Filter contacts that are not already participants
  const availableContacts = contacts.filter(
    (contact) => !participants.some((p) => p.id === contact.id || p.displayName === contact.email || p.name === contact.email)
  );

  // Filter contacts based on search query
  const filteredContacts = availableContacts.filter((contact) =>
    contact.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="mt-6 space-y-6 px-4">
      <div>
        {creator && (
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <UserProfile
                name={creator.displayName}
                url={creator.image}
                size="sm"
                className="border-inset-accent border"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {creator.id === currentUserId
                      ? `${creator.displayName} (You)`
                      : creator.displayName}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <h3 className="mb-3 flex items-center gap-2 font-medium">
          <FiUsers className="h-4 w-4" />
          {creator && creator.id !== currentUserId
            ? "Other Participants"
            : "Participants"}{" "}
          ({participants.filter((p) => !p.isCreator).length})
        </h3>
        <div className="space-y-2">
          {participants
            .filter((p) => !p.isCreator)
            .map((participant) => (
              <div
                key={participant.id}
                className={`flex items-center gap-3 rounded-lg p-2 ${
                  participant.id === currentUserId
                    ? "bg-blue-50"
                    : "bg-muted/50"
                }`}
              >
                <UserProfile
                  name={participant.displayName}
                  url={participant.image}
                  size="sm"
                  className="border-inset-accent border"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {participant.id === currentUserId
                        ? `${participant.displayName} (You)`
                        : participant.displayName}
                    </p>
                  </div>
                </div>
                
                {/* Show kick button for creators, but not for current user */}
                {isCreator && participant.id !== currentUserId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleKickParticipant(participant.id, participant.displayName || "Participant")}
                    disabled={kickingParticipant === participant.id}
                    className="flex-shrink-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                    title="Remove from call"
                  >
                    {kickingParticipant === participant.id ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
                    ) : (
                      <FiUserX className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            ))}
        </div>
      </div>

      {isCreator && (
        <>
          <Separator />
          <div>
            <h3 className="mb-3 flex items-center gap-2 font-medium">
              <FiUserPlus className="h-4 w-4" />
              Join Requests
              {joinRequests.length > 0 && (
                <Badge variant="destructive" className="ml-auto">
                  {joinRequests.length}
                </Badge>
              )}
            </h3>

            {joinRequests.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No pending requests
              </p>
            ) : (
              <div className="space-y-3">
                {joinRequests.map((request) => (
                  <div
                    key={request.id}
                    className="bg-background rounded-lg border p-3"
                  >
                    <div className="flex items-start gap-3">
                      <UserProfile
                        name={request.userName}
                        url={undefined}
                        size="sm"
                        className="border-inset-accent border"
                      />

                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {request.userName}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {request.userEmail}
                        </p>
                        <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                          <FiClock className="h-3 w-3" />
                          {new Date(request.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleApproveRequest(request.userId)}
                        disabled={loading}
                        className="flex-1"
                      >
                        <FiCheck className="mr-1 h-3 w-3" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRejectRequest(request.userId)}
                        disabled={loading}
                        className="flex-1"
                      >
                        <FiX className="mr-1 h-3 w-3" />
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Separator />

      <div>
        <h3 className="mb-3 flex items-center gap-2 font-medium">
          <FiUserPlus className="h-4 w-4" />
          Invite Contacts
        </h3>

        <div className="mb-3">
          <div className="relative">
            <FiSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {filteredContacts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {searchQuery ? "No contacts found" : "No contacts available"}
          </p>
        ) : (
          <div className="space-y-2">
            {filteredContacts.map((contact) => (
              <div
                key={contact.id}
                className="flex items-center justify-between gap-3 rounded-lg p-2 bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <UserProfile
                    name={contact.name || contact.email}
                    url={contact.image}
                    size="sm"
                    className="border-inset-accent border"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {contact.name || "No name"}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {contact.email}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleInviteContact(contact.email)}
                  disabled={invitingContact === contact.email}
                  className="flex-shrink-0"
                >
                  {invitingContact === contact.email ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <FiMail className="h-3 w-3" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
