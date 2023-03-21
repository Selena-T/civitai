import { GetByIdInput } from '~/server/schema/base.schema';
import { SessionUser } from 'next-auth';
import { isNotImageResource } from './../schema/image.schema';
import { editPostSelect } from './../selectors/post.selector';
import { isDefined } from '~/utils/type-guards';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import {
  PostUpdateInput,
  AddPostTagInput,
  AddPostImageInput,
  UpdatePostImageInput,
  PostCreateInput,
  ReorderPostImagesInput,
  RemovePostTagInput,
  GetPostTagsInput,
  PostsQueryInput,
} from './../schema/post.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { TagType, TagTarget, Prisma } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { ModelFileType } from '~/server/common/constants';
import { isImageResource } from '~/server/schema/image.schema';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import { getImageV2Select } from '~/server/selectors/imagev2.selector';
import uniqWith from 'lodash/uniqWith';
import isEqual from 'lodash/isEqual';

export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];
export const getPostsInfinite = async ({
  page,
  limit,
  cursor,
  query,
  username,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  period,
  sort,
  browsingMode,
  user,
}: PostsQueryInput & { user?: SessionUser }) => {
  const skip = (page - 1) * limit;
  const take = limit + 1;

  const AND: Prisma.Enumerable<Prisma.PostWhereInput> = [];

  const imageAND: Prisma.Enumerable<Prisma.ImageWhereInput> = [];
  if (query) AND.push({ title: { in: query, mode: 'insensitive' } });
  if (username) AND.push({ user: { username } });
  if (!!excludedTagIds?.length) {
    AND.push({ tags: { none: { tagId: { in: excludedTagIds } } } });
    imageAND.push({ tags: { none: { tagId: { in: excludedTagIds } } } });
  }
  if (!!excludedUserIds?.length) AND.push({ user: { id: { notIn: excludedUserIds } } });
  if (!!excludedImageIds?.length) imageAND.push({ id: { notIn: excludedImageIds } });

  if (browsingMode !== BrowsingMode.All) {
    const query = { nsfw: { equals: browsingMode === BrowsingMode.NSFW } };
    AND.push(query);
    imageAND.push(query);
  }

  const orderBy: Prisma.Enumerable<Prisma.PostOrderByWithRelationInput> = [];
  if (sort === PostSort.MostComments)
    orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
  else if (sort === PostSort.MostReactions)
    orderBy.push({ rank: { [`reactionCount${period}Rank`]: 'asc' } });
  orderBy.push({ id: 'desc' });

  const posts = await dbRead.post.findMany({
    skip,
    take,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    orderBy,
    select: {
      id: true,
      nsfw: true,
      title: true,
      user: { select: userWithCosmeticsSelect },
      images: {
        orderBy: { index: 'asc' },
        take: 1,
        select: getImageV2Select({ userId: user?.id }),
        where: {
          AND: imageAND,
        },
      },
    },
  });

  const postsWithImage = posts.filter((x) => !!x.images.length);
  let nextCursor: number | undefined;
  if (postsWithImage.length > limit) {
    const nextItem = postsWithImage.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: postsWithImage.map(({ images, ...post }) => ({
      ...post,
      image: images[0],
    })),
  };
};

export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const post = await dbRead.post.findUnique({
    where: { id },
    select: {
      id: true,
      nsfw: true,
      title: true,
      detail: true,
      modelVersionId: true,
      user: { select: userWithCosmeticsSelect },
      publishedAt: true,
      tags: { select: { tag: { select: simpleTagSelect } } },
    },
  });
  if (!post) throw throwNotFoundError();
  return {
    ...post,
    tags: post.tags.flatMap((x) => x.tag),
  };
};

export const getPostEditDetail = async ({ id }: GetByIdInput) => {
  const post = await dbWrite.post.findUnique({
    where: { id },
    select: editPostSelect,
  });
  if (!post) throw throwNotFoundError();
  return {
    ...post,
    tags: post.tags.flatMap((x) => x.tag),
    images: post.images.map((image) => ({ ...image, tags: image.tags.flatMap((x) => x.tag) })),
  };
};

export const createPost = async ({
  userId,
  modelVersionId,
}: PostCreateInput & { userId: number }) => {
  const result = await dbWrite.post.create({
    data: { userId, modelVersionId },
    select: editPostSelect,
  });
  return {
    ...result,
    tags: result.tags.flatMap((x) => x.tag),
    images: result.images.map((image) => ({ ...image, tags: image.tags.flatMap((x) => x.tag) })),
  };
};

export const updatePost = async (data: PostUpdateInput) => {
  await dbWrite.post.updateMany({
    where: { id: data.id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: data.detail !== undefined ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });
};

export const deletePost = async ({ id }: GetByIdInput) => {
  await dbWrite.post.delete({ where: { id } });
};

export const getPostTags = async ({ query, limit }: GetPostTagsInput) => {
  const showTrending = query === undefined || query.length < 2;
  return await dbRead.$queryRawUnsafe<
    Array<{
      id: number;
      name: string;
      isCategory: boolean;
      postCount: number;
    }>
  >(`
    SELECT
      t.id,
      t.name,
      t."isCategory",
      COALESCE(s.${showTrending ? '"postCountDay"' : '"postCountAllTime"'}, 0)::int AS "postCount"
    FROM "Tag" t
    LEFT JOIN "TagStat" s ON s."tagId" = t.id
    LEFT JOIN "TagRank" r ON r."tagId" = t.id
    WHERE
      ${showTrending ? 't."isCategory" = true' : `t.name ILIKE '${query}%'`}
    ORDER BY ${
      showTrending ? 'r."postCountDayRank" DESC' : 'LENGTH(t.name), r."postCountAllTimeRank" DESC'
    }
    LIMIT ${limit}
  `);
};

export const addPostTag = async ({ postId, id, name: initialName }: AddPostTagInput) => {
  const name = initialName.toLowerCase().trim();
  return await dbWrite.$transaction(async (tx) => {
    const tag = await tx.tag.findUnique({
      where: { name },
      select: { id: true, target: true },
    });
    if (!tag) {
      return await dbWrite.tag.create({
        data: {
          type: TagType.UserGenerated,
          target: [TagTarget.Post],
          name,
          tagsOnPosts: {
            create: {
              postId,
            },
          },
        },
        select: simpleTagSelect,
      });
    } else {
      // update the tag target if needed
      return await dbWrite.tag.update({
        where: { id: tag.id },
        data: {
          target: !tag.target.includes(TagTarget.Post) ? { push: TagTarget.Post } : undefined,
          tagsOnPosts: {
            connectOrCreate: {
              where: { tagId_postId: { tagId: tag.id, postId } },
              create: { postId },
            },
          },
        },
        select: simpleTagSelect,
      });
    }
  });
};

export const removePostTag = async ({ postId, id }: RemovePostTagInput) => {
  await dbWrite.tagsOnPost.delete({ where: { tagId_postId: { tagId: id, postId } } });
};

const toInclude: ModelFileType[] = ['Model', 'Pruned Model', 'Negative'];
export const addPostImage = async ({
  // resources,
  modelVersionId,
  meta,
  ...image
}: AddPostImageInput & { userId: number }) => {
  const metaResources = meta?.hashes
    ? Object.entries(meta.hashes).map(([name, hash]) => ({ name, hash }))
    : [];

  const modelFileHashes = !!metaResources.length
    ? await dbRead.modelFileHash.findMany({
        where: {
          file: { type: { in: toInclude } },
          hash: { in: metaResources.map((x) => x.hash), mode: 'insensitive' },
        },
        select: {
          hash: true,
          file: {
            select: { modelVersionId: true },
          },
        },
      })
    : [];

  const resources: Prisma.ImageResourceUncheckedCreateWithoutImageInput[] = metaResources.map(
    ({ name, hash }) => {
      const modelFile = modelFileHashes.find((x) => x.hash.toLowerCase() === hash.toLowerCase());
      if (modelFile) return { modelVersionId: modelFile.file.modelVersionId };
      else return { name };
    }
  );
  if (modelVersionId) resources.unshift({ modelVersionId });

  const uniqueResources = uniqWith(resources, isEqual);

  const result = await dbWrite.image.create({
    data: {
      ...image,
      meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: meta ? getImageGenerationProcess(meta as Prisma.JsonObject) : null,
      resources: !!uniqueResources.length
        ? {
            create: uniqueResources.map((resource) => ({
              ...resource,
              detected: true,
            })),
          }
        : undefined,
    },
    select: editPostImageSelect,
  });
  return { ...result, tags: result.tags.flatMap((x) => x.tag) };
};

export const updatePostImage = async (image: UpdatePostImageInput) => {
  // const updateResources = image.resources.filter(isImageResource);
  // const createResources = image.resources.filter(isNotImageResource);

  const result = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      // resources: {
      //   deleteMany: {
      //     NOT: updateResources.map((r) => ({ id: r.id })),
      //   },
      //   createMany: { data: createResources.map((r) => ({ modelVersionId: r.id, name: r.name })) },
      // },
    },
    select: editPostImageSelect,
  });

  return { ...result, tags: result.tags.flatMap((x) => x.tag) };
};

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: { id: true } })
    )
  );

  return transaction;
};

export const getPostResources = async ({ id }: GetByIdInput) => {
  return await dbRead.postResourceHelper.findMany({
    where: { postId: id },
    orderBy: { modelName: 'asc' },
  });
};