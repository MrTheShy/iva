package dev.iva.companion.wear

import androidx.concurrent.futures.ResolvableFuture
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/**
 * A tile whose only job is to be one swipe and one tap away from the microphone.
 *
 * It shows nothing dynamic on purpose: reading the last answer from the watch face
 * would put private conversation on a screen anyone standing next to you can read.
 */
class TalkTileService : TileService() {

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> = immediate(
        TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES_VERSION)
            .setFreshnessIntervalMillis(0)
            .setTileTimeline(
                TimelineBuilders.Timeline.Builder()
                    .addTimelineEntry(
                        TimelineBuilders.TimelineEntry.Builder()
                            .setLayout(
                                LayoutElementBuilders.Layout.Builder()
                                    .setRoot(layout())
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build(),
    )

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> = immediate(
        ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build(),
    )

    private fun layout(): LayoutElementBuilders.LayoutElement =
        LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setClickable(
                        ModifiersBuilders.Clickable.Builder()
                            .setId("talk")
                            .setOnClick(
                                ActionBuilders.LaunchAction.Builder()
                                    .setAndroidActivity(
                                        ActionBuilders.AndroidActivity.Builder()
                                            .setPackageName(packageName)
                                            .setClassName(MainActivity::class.java.name)
                                            .build(),
                                    )
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .addContent(
                LayoutElementBuilders.Text.Builder()
                    .setText("Parla con Iva")
                    .build(),
            )
            .build()

    private fun <T> immediate(value: T): ListenableFuture<T> =
        ResolvableFuture.create<T>().apply { set(value) }

    private companion object {
        const val RESOURCES_VERSION = "1"
    }
}
