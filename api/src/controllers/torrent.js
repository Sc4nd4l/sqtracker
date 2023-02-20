import bencode from 'bencode'
import crypto from 'crypto'
import mongoose from 'mongoose'
import slugify from 'slugify'
import Torrent from '../schema/torrent'
import User from '../schema/user'
import Comment from '../schema/comment'

export const embellishTorrentsWithTrackerScrape = async (tracker, torrents) => {
  if (!torrents.length) return []

  try {
    return torrents.map((torrent) => {
      const torrentFromTracker = tracker.torrents[torrent.infoHash]
      return {
        ...torrent,
        seeders: torrentFromTracker?.complete || 0,
        leechers: torrentFromTracker?.incomplete || 0,
      }
    })
  } catch (e) {
    console.error('[DEBUG] Error: could not embellish torrents from tracker')
    return torrents
  }
}

export const uploadTorrent = async (req, res) => {
  if (req.body.torrent && req.body.name && req.body.description) {
    try {
      const torrent = Buffer.from(req.body.torrent, 'base64')
      const parsed = bencode.decode(torrent)

      if (parsed.info.private !== 1) {
        res.status(400).send('Torrent must be set to private')
        return
      }

      if (!parsed.announce || parsed['announce-list']) {
        res.status(400).send('One and only one announce URL must be set')
        return
      }

      if (process.env.SQ_TORRENT_CATEGORIES.length && !req.body.type) {
        res.status(400).send('Torrent must have a category')
        return
      }

      if (process.env.SQ_TORRENT_CATEGORIES.length) {
        const sources =
          process.env.SQ_TORRENT_CATEGORIES[
            Object.keys(process.env.SQ_TORRENT_CATEGORIES).find(
              (cat) => slugify(cat, { lower: true }) === req.body.type
            )
          ]
        if (
          !sources
            .map((source) => slugify(source, { lower: true }))
            .includes(req.body.source)
        ) {
          res.status(400).send('Torrent must have a source')
          return
        }
      }

      const user = await User.findOne({ _id: req.userId }).lean()

      if (
        parsed.announce.toString() !==
        `${process.env.SQ_BASE_URL}/sq/${user.uid}/announce`
      ) {
        res.status(400).send('Announce URL is invalid')
        return
      }

      const infoHash = crypto
        .createHash('sha1')
        .update(bencode.encode(parsed.info))
        .digest('hex')

      const existingTorrent = await Torrent.findOne({ infoHash }).lean()

      if (existingTorrent) {
        res.status(409).send('Torrent with this info hash already exists')
        return
      }

      let files
      if (parsed.info.files) {
        files = parsed.info.files.map((file) => ({
          path: file.path.map((tok) => tok.toString()).join('/'),
          size: file.length,
        }))
      } else {
        files = [
          {
            path: parsed.info.name.toString(),
            size: parsed.info.length,
          },
        ]
      }

      const newTorrent = new Torrent({
        name: req.body.name,
        description: req.body.description,
        type: req.body.type,
        source: req.body.source,
        infoHash,
        binary: req.body.torrent,
        uploadedBy: req.userId,
        downloads: 0,
        anonymous: false,
        size:
          parsed.info.length ||
          parsed.info.files.reduce((acc, cur) => {
            return acc + cur.length
          }, 0),
        files,
        created: Date.now(),
        upvotes: [],
        downvotes: [],
        freeleech: false,
        tags: (req.body.tags ?? '')
          .split(',')
          .map((t) => slugify(t.trim(), { lower: true })),
      })

      await newTorrent.save()

      res.status(200).send(infoHash)
    } catch (e) {
      res.status(500).send(e.message)
    }
  } else {
    res.status(400).send('Form is incomplete')
  }
}

export const downloadTorrent = async (req, res) => {
  const { infoHash, userId } = req.params

  const user = await User.findOne({ uid: userId }).lean()

  if (!user) {
    res.status(401).send(`User does not exist`)
    return
  }

  const torrent = await Torrent.findOne({ infoHash }).lean()
  const { binary } = torrent
  const parsed = bencode.decode(Buffer.from(binary, 'base64'))

  parsed.announce = `${process.env.SQ_BASE_URL}/sq/${user.uid}/announce`
  parsed.info.private = 1

  res.setHeader('Content-Type', 'application/x-bittorrent')
  res.setHeader(
    'Content-Disposition',
    `attachment;filename=${parsed.info.name.toString()}.torrent`
  )
  res.write(bencode.encode(parsed))
  res.end()
}

export const fetchTorrent = (tracker) => async (req, res) => {
  const { infoHash } = req.params

  try {
    const [torrent] = await Torrent.aggregate([
      {
        $match: { infoHash },
      },
      {
        $project: {
          name: 1,
          description: 1,
          type: 1,
          source: 1,
          infoHash: 1,
          uploadedBy: 1,
          downloads: 1,
          anonymous: 1,
          size: 1,
          files: 1,
          created: 1,
          upvotes: { $size: '$upvotes' },
          downvotes: { $size: '$downvotes' },
          userHasUpvoted: { $in: [req.userId, '$upvotes'] },
          userHasDownvoted: { $in: [req.userId, '$downvotes'] },
          freeleech: 1,
          tags: 1,
        },
      },
      {
        $lookup: {
          from: 'users',
          as: 'uploadedBy',
          let: { userId: '$uploadedBy' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$userId'] } } },
            {
              $project: {
                username: 1,
                created: 1,
              },
            },
          ],
        },
      },
      { $unwind: { path: '$uploadedBy', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'comments',
          as: 'comments',
          let: { parentId: '$_id' },
          pipeline: [
            {
              $match: {
                type: 'torrent',
                $expr: { $eq: ['$parentId', '$$parentId'] },
              },
            },
            {
              $lookup: {
                from: 'users',
                as: 'user',
                let: { userId: '$userId' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$_id', '$$userId'] },
                    },
                  },
                  {
                    $project: {
                      username: 1,
                    },
                  },
                ],
              },
            },
            {
              $unwind: {
                path: '$user',
                preserveNullAndEmptyArrays: true,
              },
            },
            { $sort: { created: -1 } },
          ],
        },
      },
    ])

    if (!torrent) {
      res.status(404).send(`Torrent with info hash ${infoHash} does not exist`)
      return
    }

    if (torrent.anonymous) delete torrent.uploadedBy

    const [embellishedTorrent] = await embellishTorrentsWithTrackerScrape(
      tracker,
      [torrent]
    )

    res.json(embellishedTorrent)
  } catch (e) {
    console.error(e)
    res.status(500).send(e.message)
  }
}

export const deleteTorrent = async (req, res) => {
  try {
    const torrent = await Torrent.findOne({
      infoHash: req.params.infoHash,
    }).lean()

    if (!torrent) {
      res.status(404).send('Torrent could not be found')
      return
    }

    if (
      req.userRole !== 'admin' &&
      req.userId.toString() !== torrent.uploadedBy.toString()
    ) {
      res.status(401).send('You do not have permission to delete this torrent')
      return
    }

    await Torrent.deleteOne({ infoHash: req.params.infoHash })

    res.sendStatus(200)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const getTorrentsPage = async ({
  skip = 0,
  limit = 25,
  query,
  category,
  source,
  tag,
  userId,
  tracker,
}) => {
  const torrents = await Torrent.aggregate([
    {
      $project: {
        infoHash: 1,
        name: 1,
        description: 1,
        type: 1,
        source: 1,
        downloads: 1,
        uploadedBy: 1,
        created: 1,
        freeleech: 1,
        tags: 1,
      },
    },
    ...(query
      ? [
          {
            $match: {
              $or: [
                { name: { $regex: query, $options: 'i' } },
                { description: { $regex: query, $options: 'i' } },
              ],
            },
          },
        ]
      : []),
    ...(category
      ? [
          {
            $match: {
              type: category,
            },
          },
        ]
      : []),
    ...(source
      ? [
          {
            $match: {
              source,
            },
          },
        ]
      : []),
    ...(tag
      ? [
          {
            $match: {
              $expr: { $in: [tag, '$tags'] },
            },
          },
        ]
      : []),
    ...(userId
      ? [
          {
            $match: {
              uploadedBy: userId,
            },
          },
        ]
      : []),
    {
      $sort: { created: -1 },
    },
    {
      $skip: skip,
    },
    {
      $limit: limit,
    },
    {
      $lookup: {
        from: 'comments',
        as: 'comments',
        let: { parentId: '$_id' },
        pipeline: [
          {
            $match: {
              type: 'torrent',
              $expr: { $eq: ['$parentId', '$$parentId'] },
            },
          },
          { $count: 'count' },
        ],
      },
    },
    {
      $unwind: {
        path: '$comments',
        preserveNullAndEmptyArrays: true,
      },
    },
  ])

  const [count] = await Torrent.aggregate([
    ...(query
      ? [
          {
            $match: {
              $or: [
                { name: { $regex: query, $options: 'i' } },
                { description: { $regex: query, $options: 'i' } },
              ],
            },
          },
        ]
      : []),
    ...(category
      ? [
          {
            $match: {
              type: category,
            },
          },
        ]
      : []),
    ...(source
      ? [
          {
            $match: {
              source,
            },
          },
        ]
      : []),
    ...(tag
      ? [
          {
            $match: {
              $expr: { $in: [tag, '$tags'] },
            },
          },
        ]
      : []),
    ...(userId
      ? [
          {
            $match: {
              uploadedBy: userId,
            },
          },
        ]
      : []),
    {
      $count: 'total',
    },
  ])

  return {
    torrents: await embellishTorrentsWithTrackerScrape(tracker, torrents),
    ...count,
  }
}

export const listLatest = (tracker) => async (req, res) => {
  let { count } = req.query
  count = parseInt(count) || 25
  count = Math.min(count, 100)
  try {
    const { torrents } = await getTorrentsPage({ limit: count, tracker })
    res.json(torrents)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const searchTorrents = (tracker) => async (req, res) => {
  const { query, category, source, tag, page } = req.query
  try {
    const torrents = await getTorrentsPage({
      skip: page ? parseInt(page) : 0,
      query: query ? decodeURIComponent(query) : undefined,
      category,
      source,
      tag,
      tracker,
    })
    res.json(torrents)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const addComment = async (req, res) => {
  if (req.body.comment) {
    try {
      const { infoHash } = req.params

      const torrent = await Torrent.findOne({ infoHash }).lean()

      if (!torrent) {
        res.status(404).send('Torrent does not exist')
        return
      }

      const comment = new Comment({
        type: 'torrent',
        parentId: torrent._id,
        userId: req.userId,
        comment: req.body.comment,
        created: Date.now(),
      })
      await comment.save()

      res.sendStatus(200)
    } catch (err) {
      res.status(500).send(err.message)
    }
  } else {
    res.status(400).send('Request must include comment')
  }
}

export const addVote = async (req, res) => {
  const { infoHash, vote } = req.params
  try {
    const torrent = await Torrent.findOne({ infoHash }).lean()

    if (!torrent) {
      res.status(404).send('Torrent could not be found')
      return
    }

    if (vote === 'up' || vote === 'down') {
      await Torrent.findOneAndUpdate(
        { infoHash },
        {
          $addToSet: {
            [vote === 'up' ? 'upvotes' : 'downvotes']: mongoose.Types.ObjectId(
              req.userId
            ),
          },
          $pull: {
            [vote === 'down' ? 'upvotes' : 'downvotes']:
              mongoose.Types.ObjectId(req.userId),
          },
        }
      )
      res.sendStatus(200)
    } else {
      res.status(400).send('Vote must be one of up, down')
    }
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const removeVote = async (req, res) => {
  const { infoHash, vote } = req.params
  try {
    const torrent = await Torrent.findOne({ infoHash }).lean()

    if (!torrent) {
      res.status(404).send('Torrent could not be found')
      return
    }

    if (vote === 'up' || vote === 'down') {
      await Torrent.findOneAndUpdate(
        { infoHash },
        {
          $pull: {
            [vote === 'up' ? 'upvotes' : 'downvotes']: mongoose.Types.ObjectId(
              req.userId
            ),
          },
        }
      )
      res.sendStatus(200)
    } else {
      res.status(400).send('Vote must be one of (up, down)')
    }
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const toggleFreeleech = async (req, res) => {
  const { infoHash } = req.params
  try {
    if (req.userRole !== 'admin') {
      res.status(401).send('You do not have permission to toggle freeleech')
      return
    }

    const torrent = await Torrent.findOne({ infoHash }).lean()

    if (!torrent) {
      res.status(404).send('Torrent could not be found')
      return
    }

    await Torrent.findOneAndUpdate(
      { infoHash },
      { $set: { freeleech: !torrent.freeleech } }
    )
    res.sendStatus(200)
  } catch (e) {
    res.status(500).send(e.message)
  }
}
