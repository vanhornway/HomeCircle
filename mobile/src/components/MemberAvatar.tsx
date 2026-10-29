import type { CircleClient, Member } from '@homecircle/core';
import { Avatar } from './ui';
import { usePhotoUri } from '../lib/photos';

/** A member's avatar: their photo once it's on this phone, else their initials. */
export function MemberAvatar({ client, member, size = 44 }: { client: CircleClient; member: Member; size?: number }) {
  const uri = usePhotoUri(client, member.photo);
  return <Avatar name={member.name} color={member.color} size={size} uri={uri} />;
}
