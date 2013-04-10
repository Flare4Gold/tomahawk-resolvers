/*
    Copyright (c) 2011 Leo Franchi <leo@kdab.com>
    Copyright (c) 2012,Hugo Lindström <hugolm84@gmail.com>

    Permission is hereby granted, free of charge, to any person
    obtaining a copy of this software and associated documentation
    files (the "Software"), to deal in the Software without
    restriction, including without limitation the rights to use,
    copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the
    Software is furnished to do so, subject to the following
    conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
    OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
    HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
    WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
    OTHER DEALINGS IN THE SOFTWARE.
*/

#include "audiohttpserver.h"
#include "spotifyresolver.h"
#include "QxtWebPageEvent"
#include "spotifyiodevice.h"
#include <QString>
#include <QDebug>

AudioHTTPServer::AudioHTTPServer( QxtAbstractWebSessionManager* sm, int port, QObject* parent )
    : QxtWebSlotService( sm, parent )
    , m_port( port )
    , m_savedDuration( 0 )
    , m_savedByteRange( 0 )
{
//    qDebug() << "NEW AUDIO HTTP SERVER!";
}

AudioHTTPServer::~AudioHTTPServer()
{
}

void AudioHTTPServer::sid( QxtWebRequestEvent* event, QString a )
{
    qDebug() << QThread::currentThreadId() << "HTTP" << event->url.toString() << a;
    // byte range, if seek
    int m_savedByteRange = QString(event->headers.value( "Range" ) ).remove( "bytes=" ).remove( "-" ).toInt();

    qDebug() << "Got savedByteRange?" << m_savedByteRange;
    qDebug() << "sid Headers" << event->headers;

    // the requested track
    QString uid = a.replace( ".wav", "");

    if( m_savedByteRange != 0 )
    {
        if( !m_savedTrackUri.isEmpty() && uid == m_savedTrackUri && m_savedByteRange > 0 && m_savedDuration > 0 )
        {
            int seek = convertByteRangeToMsec( m_savedByteRange );
            if( seek <= 0 )
            {
                qDebug() << "Seekrange was invaild, aborting" << seek;
                sendErrorResponse( event );
                return;
            }

            performSeek( event, seek, uid );
            return;
        }
    }
    else
    {

        if( !SpotifySession::getInstance()->Playback()->trackIsOver() )
        {
            SpotifySession::getInstance()->Playback()->endTrack();
        }
    //    qDebug() << QThread::currentThreadId() << "Beginning to stream requested track:" << uid;
        if( uid.isEmpty() || !sApp->hasLinkFromTrack( uid ) ) {
            qWarning() << "Did not find spotify track UID in our list!" << uid;
            sendErrorResponse( event );
            return;
        }

        // get the sp_track
        sp_link* link = sApp->linkFromTrack( uid );
        sp_track* track = sp_link_as_track( link );
        m_savedTrackUri = uid;

        if( !track )
        {
            qWarning() << QThread::currentThreadId() << "Uh oh... got null track from link :(" << sp_link_type( link );
            sendErrorResponse( event );
            return;
        }
        if( !sp_track_is_loaded( track ) )
        {
            qWarning() << QThread::currentThreadId() << "uh oh... track not loaded yet! Asked for:" << sp_track_name( track );
            m_savedEvent = event;
            m_savedTrack = track;
            QTimer::singleShot( 250, this, SLOT( checkForLoaded() ) );
            return;

        } else
        {
            startStreamingResponse( event, track );
        }
    }
}


void AudioHTTPServer::performSeek( QxtWebRequestEvent* event, int seek, QString uid)
{

    // Perform seek
    spotifyiodev_ptr iodev = SpotifySession::getInstance()->Playback()->getIODeviceForNewTrack( m_savedDuration-seek );
    qDebug()  << QThread::currentThreadId() << "Got iodevice to send:" << iodev << iodev.isNull() << iodev->isSequential() << iodev->isReadable();

    if( SpotifySession::getInstance()->Playback()->trackIsOver() )
    {
        qDebug() << " Seeking on track thats ended, setting offset";

        sp_link* link = sApp->linkFromTrack( uid );
        sp_track* track = sp_link_as_track( link );

        sp_error err = sp_session_player_load( SpotifySession::getInstance()->Session(), track );
        if( err != SP_ERROR_OK )
        {
            qWarning() << QThread::currentThreadId() << "Failed to restart track with offset from spotify :(" << sp_error_message( err );
            sendErrorResponse( event );
            return;
        }

        sp_session_player_seek( SpotifySession::getInstance()->Session(), seek );
        sp_session_player_play( SpotifySession::getInstance()->Session(), true );
        SpotifySession::getInstance()->Playback()->startPlaying();

    }
    else
    {
        qDebug() << " Seeking on track thats still playing";
        sp_session_player_seek( SpotifySession::getInstance()->Session(), seek );
    }
    // Partial Content
    QxtWebPageEvent* wpe = new QxtWebPageEvent( event->sessionID, event->requestID, iodev );
    wpe->streaming = true;
    wpe->status = 206;
    QString range = QString::number(m_savedByteRange) + "-" + QString::number(m_savedDurationInBytes);
    wpe->headers.insert("Content-Range", "bytes=" + range);
    wpe->contentType = "audio/basic";
    postEvent( wpe );

}

int AudioHTTPServer::convertByteRangeToMsec( int byteRange )
{

    if( byteRange > 0 )
    {
        qDebug() << " === GOT BYTES " << byteRange;
        //The bit rate is then 44100 samples/second x 16 bits/sample x 2 tracks
        int seek = byteRange / SpotifySession::getInstance()->Playback()->m_currSamples * 16 * SpotifySession::getInstance()->Playback()->m_currChannels * 8;

        /// @magic: magic number to set the seek msec straight! Donno why it works
        ///         probably a misscalc in byte to msec
        /// Every minute, we need to remove 1440msec from the seek
        seek = seek - (seek/1000/60 * 1440);

        // extraDebug
        int seconds = seek/1000;
        int hrs  = seconds / 60 / 60;
        int mins = seconds / 60 % 60;
        int secs = seconds % 60;

        qDebug() << " ==== Seeking to : " << QString( "%1%2:%3" ).arg( hrs > 0 ? hrs  < 10 ? "0" + QString::number( hrs ) + ":" : QString::number( hrs ) + ":" : "" )
                                   .arg( mins < 10 ? "0" + QString::number( mins ) : QString::number( mins ) )
                    .arg( secs < 10 ? "0" + QString::number( secs ) : QString::number( secs ) ) << " ======";
        return seek;

    }
    return -1;
}


void AudioHTTPServer::checkForLoaded()
{
     qDebug() << "Checking...";
    if( !sp_track_is_loaded( m_savedTrack ) ) {
         qWarning() << QThread::currentThreadId() << "uh oh... track not loaded yet! Asked for:" << sp_track_name( m_savedTrack );
        QTimer::singleShot( 250, this, SLOT( checkForLoaded() ) );
    } else {
        startStreamingResponse( m_savedEvent, m_savedTrack );
    }

}

void AudioHTTPServer::startStreamingResponse( QxtWebRequestEvent* event, sp_track* track )
{
    // yay we gots a track
//    qDebug() << QThread::currentThreadId() << "We got a track!" << sp_track_name( track ) << sp_artist_name( sp_track_artist( track, 0 ) ) << sp_track_duration( track );
    uint duration = sp_track_duration( track );

    sp_error err = sp_session_player_load( SpotifySession::getInstance()->Session(), track );
    if( err != SP_ERROR_OK ) {
        qWarning() << QThread::currentThreadId() << "Failed to start track from spotify :(" << sp_error_message( err );
        sendErrorResponse( event );
        return;
    }

//    qDebug() << QThread::currentThreadId() << "Starting to play!";
    sp_session_player_play( SpotifySession::getInstance()->Session(), true );
    SpotifySession::getInstance()->Playback()->startPlaying();

    m_savedDuration = duration;
    m_savedDurationInBytes = duration * SpotifySession::getInstance()->Playback()->m_currSamples * 16 * SpotifySession::getInstance()->Playback()->m_currChannels / 8;

    qDebug() << "Getting iodevice...";
    qDebug() << "Setting durationBytes" << m_savedByteRange;

    spotifyiodev_ptr iodev = SpotifySession::getInstance()->Playback()->getIODeviceForNewTrack( duration );
//    qDebug()  << QThread::currentThreadId() << "Got iodevice to send:" << iodev << iodev.isNull() << iodev->isSequential() << iodev->isReadable();
    QxtWebPageEvent* wpe = new QxtWebPageEvent( event->sessionID, event->requestID, iodev );
    wpe->streaming = true;
    // Partial Content
    wpe->status = 206;
    wpe->headers.insert("Content-Range", "bytes=" + QString::number(0) + "-" + QString::number( m_savedDurationInBytes ) );
    wpe->contentType = "audio/basic";
    postEvent( wpe );
}




QString AudioHTTPServer::urlForID( const QString& id )
{
    return QString( "http://localhost:%1/sid/%2.wav" ).arg( m_port ).arg( id );
}

void
AudioHTTPServer::sendErrorResponse( QxtWebRequestEvent* event )
{
    qDebug() << "404" << event->url.toString();
    QxtWebPageEvent* wpe = new QxtWebPageEvent( event->sessionID, event->requestID, "<h1>No Such Track</h1>" );
    wpe->status = 403;
    wpe->statusMessage = "no track found";
    postEvent( wpe );
}
